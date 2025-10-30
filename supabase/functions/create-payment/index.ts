import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type IntentState =
  | "collect_contact"
  | "otp_verified"
  | "awaiting_payment"
  | "active"
  | "expired"
  | "cancelled";

interface CreatePaymentPayload {
  intent_id: string;
}

interface SignupIntent {
  id: string;
  state: IntentState;
  user_id: string;
  numero_whatsapp: string | null;
  metadata: Record<string, unknown> | null;
}

interface Formule {
  id: string;
  nom: string;
  prix_fcfa: number;
  duree_jours: number;
  essai_gratuit: boolean;
}

interface User {
  id: string;
  nom: string | null;
  numero_whatsapp: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ipayPublicKey = Deno.env.get("IPAY_PUBLIC_KEY") ?? "";
const ipayEnvironment = Deno.env.get("IPAY_ENVIRONMENT") ?? "live";
const ipayRedirectUrl = Deno.env.get("IPAY_REDIRECT_URL") ?? "";
const ipayCallbackUrl = Deno.env.get("IPAY_CALLBACK_URL") ?? "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("[create-payment] Missing Supabase credentials in environment variables.");
}

if (!ipayPublicKey) {
  console.warn("[create-payment] Missing IPAY_PUBLIC_KEY in environment variables.");
}

if (!ipayRedirectUrl) {
  console.warn("[create-payment] Missing IPAY_REDIRECT_URL in environment variables.");
}

if (!ipayCallbackUrl) {
  console.warn("[create-payment] Missing IPAY_CALLBACK_URL in environment variables.");
}

function buildSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

function generateTransactionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

async function fetchIntent(
  supabase: ReturnType<typeof buildSupabaseClient>,
  intentId: string
): Promise<{ intent: SignupIntent; formule: Formule; user: User }> {
  const { data, error } = await supabase
    .from("signup_intents")
    .select(
      `
        *,
        user:user_id (id, nom, numero_whatsapp),
        formules:formule_id (id, nom, prix_fcfa, duree_jours, essai_gratuit)
      `
    )
    .eq("id", intentId)
    .maybeSingle<SignupIntent & { user: User | null; formules: Formule | null }>();

  if (error) {
    throw new Error(`Erreur lors de la récupération de l'intent: ${error.message}`);
  }

  if (!data) {
    const err = new Error("intent_not_found");
    err.name = "not_found";
    throw err;
  }

  if (!data.user) {
    const err = new Error("missing_user");
    err.name = "bad_request";
    throw err;
  }

  if (!data.formules) {
    const err = new Error("missing_formule");
    err.name = "bad_request";
    throw err;
  }

  if (!data.user_id) {
    const err = new Error("missing_user");
    err.name = "bad_request";
    throw err;
  }

  return { intent: data, user: data.user, formule: data.formules };
}

async function ensureAbonnement(
  supabase: ReturnType<typeof buildSupabaseClient>,
  userId: string,
  intentId: string,
  formule: Formule
) {
  const { data: existing } = await supabase
    .from("abonnements")
    .select("id, date_fin")
    .eq("intent_id", intentId)
    .maybeSingle<{ id: string; date_fin: string }>();

  if (existing?.id) {
    return { abonnementId: existing.id, dateFin: existing.date_fin };
  }

  const start = new Date();
  const end = addDays(start, formule.duree_jours || 0);

  const { data, error } = await supabase
    .from("abonnements")
    .insert({
      user_id: userId,
      formule_id: formule.id,
      date_debut: start.toISOString(),
      date_fin: end.toISOString(),
      statut: "en_attente",
      renouvellement_auto: false,
      intent_id: intentId,
      duration_days: formule.duree_jours,
    })
    .select("id, date_fin")
    .single<{ id: string; date_fin: string }>();

  if (error || !data) {
    throw new Error(`Erreur lors de la création de l'abonnement: ${error?.message ?? "unknown"}`);
  }

  await supabase.rpc("refresh_user_subscription_status", { p_user_id: userId });

  return { abonnementId: data.id, dateFin: data.date_fin };
}

async function activateFreeTrial(
  supabase: ReturnType<typeof buildSupabaseClient>,
  intent: SignupIntent,
  user: User,
  abonnementId: string
) {
  await supabase
    .from("abonnements")
    .update({ statut: "actif" })
    .eq("id", abonnementId);

  await supabase.rpc("refresh_user_subscription_status", { p_user_id: user.id });

  await supabase
    .from("signup_intents")
    .update({
      state: "active",
      last_error: null,
      metadata: {
        ...(intent.metadata ?? {}),
        activated_at: new Date().toISOString(),
        activation_mode: "free_trial",
      },
    })
    .eq("id", intent.id);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "method_not_allowed", message: "Méthode non supportée" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!ipayPublicKey) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "configuration_error",
        message: "Clé publique iPay non configurée. Contactez un administrateur.",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!ipayRedirectUrl || !ipayCallbackUrl) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "configuration_error",
        message: "Les URL de redirection ou de rappel iPay ne sont pas configurées.",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const payload = (await req.json()) as CreatePaymentPayload;
    if (!payload?.intent_id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_intent",
          message: "L'identifiant d'inscription est requis",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = buildSupabaseClient();
    const { intent, formule, user } = await fetchIntent(supabase, payload.intent_id);

    if (!["otp_verified", "awaiting_payment"].includes(intent.state)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "invalid_state",
          message: "Cette inscription n'est pas prête pour l'étape de paiement",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const amount = formule.prix_fcfa ?? 0;
    const { abonnementId } = await ensureAbonnement(supabase, intent.user_id, intent.id, formule);

    if (amount <= 0 || formule.essai_gratuit) {
      await supabase
        .from("paiements")
        .insert({
          user_id: intent.user_id,
          abonnement_id: abonnementId,
          formule_id: formule.id,
          montant_fcfa: 0,
          methode_paiement: "iPayMoney-free",
          statut: "confirme",
          notes: "Activation automatique d'une période gratuite",
          intent_id: intent.id,
        });

      await activateFreeTrial(supabase, intent, user, abonnementId);

      return new Response(
        JSON.stringify({
          success: true,
          mode: "free_trial",
          message: "Période gratuite activée",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const transactionId = generateTransactionId();

    const { data: payment, error: paymentError } = await supabase
      .from("paiements")
      .insert({
        user_id: intent.user_id,
        abonnement_id: abonnementId,
        formule_id: formule.id,
        montant_fcfa: amount,
        methode_paiement: "iPayMoney-sdk",
        statut: "en_attente",
        notes: `Payment initiated via SDK - ${new Date().toISOString()}`,
        intent_id: intent.id,
        ipay_transaction_id: transactionId,
        ipay_status: "initiated",
      })
      .select("id")
      .single<{ id: string }>();

    if (paymentError || !payment) {
      throw new Error(paymentError?.message ?? "Erreur lors de la création du paiement");
    }

    await supabase
      .from("signup_intents")
      .update({
        state: "awaiting_payment",
        payment_attempts: (intent.payment_attempts ?? 0) + 1,
        last_error: null,
        metadata: {
          ...(intent.metadata ?? {}),
          last_payment_attempt_at: new Date().toISOString(),
          last_payment_transaction: transactionId,
        },
      })
      .eq("id", intent.id);

    return new Response(
      JSON.stringify({
        success: true,
        payment_id: payment.id,
        transaction_id: transactionId,
        amount,
        public_key: ipayPublicKey,
        environment: ipayEnvironment,
        redirect_url: ipayRedirectUrl,
        callback_url: ipayCallbackUrl,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    if ((error as Error).name === "not_found") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "intent_not_found",
          message: "Intention d'inscription introuvable",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if ((error as Error).name === "bad_request") {
      return new Response(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
          message: "Données incomplètes pour traiter ce paiement",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.error("[create-payment] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : "Erreur interne du serveur",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
