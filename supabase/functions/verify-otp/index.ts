import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type SignupIntentState =
  | "collect_contact"
  | "otp_verified"
  | "awaiting_payment"
  | "active"
  | "expired"
  | "cancelled";

interface VerifyOtpPayload {
  intent_id: string;
  otp_code: string;
}

interface SignupIntent {
  id: string;
  state: SignupIntentState;
  numero_whatsapp: string;
  numero_whatsapp_normalized: string;
  nom: string | null;
  email: string | null;
  country_code: string | null;
  formule_id: string | null;
  expires_at: string | null;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
  otp_attempts: number;
}

interface OtpCodeRecord {
  id: string;
  numero_whatsapp: string;
  otp_code: string;
  expires_at: string;
  attempts: number;
  created_at: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_OTP_ATTEMPTS = 3;
const INTENT_POST_OTP_EXPIRATION_HOURS = 24;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function buildSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

function isIntentExpired(intent: SignupIntent): boolean {
  if (!intent.expires_at) return false;
  return new Date(intent.expires_at).getTime() < Date.now();
}

function extendIntentExpiration(): string {
  return new Date(Date.now() + INTENT_POST_OTP_EXPIRATION_HOURS * 60 * 60 * 1000).toISOString();
}

async function fetchIntent(
  intentId: string,
  supabase: ReturnType<typeof buildSupabaseClient>
): Promise<SignupIntent> {
  const { data, error } = await supabase
    .from("signup_intents")
    .select("*")
    .eq("id", intentId)
    .maybeSingle<SignupIntent>();

  if (error) {
    throw new Error(`Erreur lors de la récupération de l'intent: ${error.message}`);
  }

  if (!data) {
    const err = new Error("intent_not_found");
    err.name = "not_found";
    throw err;
  }

  return data;
}

async function fetchOtpRecord(
  phone: string,
  supabase: ReturnType<typeof buildSupabaseClient>
): Promise<OtpCodeRecord | null> {
  const { data, error } = await supabase
    .from("otp_codes")
    .select("*")
    .eq("numero_whatsapp", phone)
    .maybeSingle<OtpCodeRecord>();

  if (error) {
    throw new Error(`Erreur lors de la récupération de l'OTP: ${error.message}`);
  }

  return data ?? null;
}

async function ensureUserRecord(
  intent: SignupIntent,
  supabase: ReturnType<typeof buildSupabaseClient>
): Promise<string> {
  if (intent.user_id) {
    await supabase
      .from("users")
      .update({
        nom: intent.nom ?? undefined,
        email: intent.email ?? undefined,
        whatsapp_verifie: true,
      })
      .eq("id", intent.user_id);
    return intent.user_id;
  }

  const { data: existingUser } = await supabase
    .from("users")
    .select("id")
    .eq("numero_whatsapp", intent.numero_whatsapp_normalized)
    .maybeSingle<{ id: string }>();

  if (existingUser?.id) {
    await supabase
      .from("users")
      .update({
        nom: intent.nom ?? undefined,
        email: intent.email ?? undefined,
        whatsapp_verifie: true,
      })
      .eq("id", existingUser.id);
    return existingUser.id;
  }

  const insertPayload = {
    nom: intent.nom ?? null,
    email: intent.email ?? null,
    numero_whatsapp: intent.numero_whatsapp_normalized,
    whatsapp_verifie: true,
    statut_abonnement: "en_attente" as const,
  };

  const { data, error } = await supabase
    .from("users")
    .insert(insertPayload)
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    throw new Error(`Erreur lors de la création du compte utilisateur: ${error?.message ?? "unknown"}`);
  }

  return data.id;
}

async function markIntentAs(
  intentId: string,
  values: Partial<SignupIntent>,
  supabase: ReturnType<typeof buildSupabaseClient>
) {
  await supabase.from("signup_intents").update(values).eq("id", intentId);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "method_not_allowed",
        message: "Méthode non supportée",
      }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const payload = (await req.json()) as VerifyOtpPayload;

    if (!payload?.intent_id || !payload?.otp_code) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_fields",
          message: "L'identifiant d'inscription et le code OTP sont requis",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = buildSupabaseClient();

    const intent = await fetchIntent(payload.intent_id, supabase);

    if (["active", "cancelled"].includes(intent.state)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "intent_not_valid",
          message: "Cette inscription est déjà finalisée. Veuillez vous connecter.",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (intent.state === "expired" || isIntentExpired(intent)) {
      await markIntentAs(
        intent.id,
        {
          state: "expired",
          last_error: "OTP expiré",
        },
        supabase
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: "intent_expired",
          message: "Le délai pour vérifier ce code est expiré. Veuillez recommencer.",
        }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const otpRecord = await fetchOtpRecord(intent.numero_whatsapp_normalized, supabase);

    if (!otpRecord) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "otp_not_found",
          message: "Aucun code OTP actif pour ce numéro. Veuillez en redemander un nouveau.",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date();
    if (now > new Date(otpRecord.expires_at)) {
      await supabase.from("otp_codes").delete().eq("id", otpRecord.id);
      await markIntentAs(
        intent.id,
        {
          last_error: "OTP expiré",
        },
        supabase
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: "otp_expired",
          message: "Ce code a expiré. Veuillez demander un nouveau code.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
      await supabase.from("otp_codes").delete().eq("id", otpRecord.id);
      await markIntentAs(
        intent.id,
        {
          last_error: "Nombre maximal de tentatives dépassé",
          state: "cancelled",
        },
        supabase
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: "max_attempts",
          message: "Nombre maximum de tentatives atteint. Veuillez recommencer le processus.",
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (otpRecord.otp_code !== payload.otp_code) {
      const updatedAttempts = otpRecord.attempts + 1;
      await supabase.from("otp_codes").update({ attempts: updatedAttempts }).eq("id", otpRecord.id);

      await markIntentAs(
        intent.id,
        {
          otp_attempts: intent.otp_attempts + 1,
          last_error: "Code OTP incorrect",
        },
        supabase
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: "invalid_code",
          message: `Code incorrect. Il vous reste ${MAX_OTP_ATTEMPTS - updatedAttempts} tentative(s).`,
          attempts_remaining: Math.max(0, MAX_OTP_ATTEMPTS - updatedAttempts),
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = await ensureUserRecord(intent, supabase);

    await supabase.from("otp_codes").delete().eq("id", otpRecord.id);

    await supabase
      .from("signup_intents")
      .update({
        state: "otp_verified",
        user_id: userId,
        otp_attempts: 0,
        expires_at: extendIntentExpiration(),
        last_error: null,
        metadata: {
          ...(intent.metadata ?? {}),
          otp_verified_at: new Date().toISOString(),
        },
      })
      .eq("id", intent.id);

    await supabase.rpc("log_otp_event", {
      p_numero_whatsapp: intent.numero_whatsapp_normalized,
      p_event_type: "verified",
      p_metadata: {
        intent_id: intent.id,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        intent_id: intent.id,
        user_id: userId,
        state: "otp_verified",
        message: "Numéro WhatsApp vérifié avec succès",
        requires_password: true,
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

    console.error("[verify-otp] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        message: "Erreur interne du serveur",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
