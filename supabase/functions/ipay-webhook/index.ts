import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type WebhookStatus = "succeeded" | "failed" | "pending";
type PaymentStatus = "confirme" | "echoue" | "en_attente";

interface WebhookPayload {
  reference?: string;
  status: WebhookStatus;
  amount?: string;
  currency?: string;
  msisdn?: string;
  customer_name?: string;
  transaction_id?: string;
  user_id?: string;
  abonnement_id?: string;
  paiement_id?: string;
  external_reference?: string;
}

interface PaiementRecord {
  id: string;
  user_id: string;
  abonnement_id: string | null;
  statut: PaymentStatus;
  intent_id: string | null;
  ipay_reference: string | null;
  ipay_transaction_id: string | null;
  montant_fcfa: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function buildSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

function mapStatus(status: WebhookStatus): PaymentStatus {
  switch (status) {
    case "succeeded":
      return "confirme";
    case "failed":
      return "echoue";
    default:
      return "en_attente";
  }
}

async function findPaiement(
  supabase: ReturnType<typeof buildSupabaseClient>,
  payload: WebhookPayload
): Promise<PaiementRecord | null> {
  const selectors: Array<{ column: keyof PaiementRecord | string; value: string | null | undefined }> = [
    { column: "id", value: payload.paiement_id ?? null },
    { column: "ipay_reference", value: payload.reference ?? null },
    { column: "ipay_transaction_id", value: payload.transaction_id ?? null },
  ];

  for (const selector of selectors) {
    if (!selector.value) continue;
    const { data } = await supabase
      .from("paiements")
      .select("id, user_id, abonnement_id, statut, intent_id, ipay_reference, ipay_transaction_id, montant_fcfa")
      .eq(selector.column as string, selector.value)
      .maybeSingle<PaiementRecord>();
    if (data) {
      return data;
    }
  }

  if (payload.abonnement_id) {
    const { data } = await supabase
      .from("paiements")
      .select("id, user_id, abonnement_id, statut, intent_id, ipay_reference, ipay_transaction_id, montant_fcfa")
      .eq("abonnement_id", payload.abonnement_id)
      .order("created_at", { ascending: false })
      .maybeSingle<PaiementRecord>();
    if (data) {
      return data;
    }
  }

  return null;
}

async function updatePollingJob(
  supabase: ReturnType<typeof buildSupabaseClient>,
  paiementId: string,
  status: "completed" | "failed"
) {
  await supabase
    .from("payment_polling_jobs")
    .update({
      status,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("paiement_id", paiementId)
    .eq("status", "active");
}

async function recordPaymentEvent(
  supabase: ReturnType<typeof buildSupabaseClient>,
  paiementId: string,
  userId: string,
  newStatus: PaymentStatus,
  payload: WebhookPayload,
  intentId: string | null
) {
  await supabase.from("payment_events").insert({
    payment_id: paiementId,
    user_id: userId,
    event_type:
      newStatus === "confirme" ? "paid" : newStatus === "en_attente" ? "pending" : "failed",
    new_status: newStatus,
    ipay_transaction_id: payload.transaction_id ?? null,
    ipay_status: payload.status,
    metadata: {
      reference: payload.reference ?? null,
      amount: payload.amount ?? null,
      currency: payload.currency ?? null,
      msisdn: payload.msisdn ?? null,
      abonnement_id: payload.abonnement_id ?? null,
    },
    intent_id: intentId,
  });
}

async function activateSubscription(
  supabase: ReturnType<typeof buildSupabaseClient>,
  paiement: PaiementRecord,
  payload: WebhookPayload
) {
  if (paiement.abonnement_id) {
    await supabase
      .from("abonnements")
      .update({
        statut: "actif",
        updated_at: new Date().toISOString(),
      })
      .eq("id", paiement.abonnement_id);
  }

  await supabase.rpc("refresh_user_subscription_status", { p_user_id: paiement.user_id });

  if (paiement.intent_id) {
    await supabase
      .from("signup_intents")
      .update({
        state: "active",
        last_error: null,
        metadata: {
          last_payment_status: payload.status,
          payment_confirmed_at: new Date().toISOString(),
        },
      })
      .eq("id", paiement.intent_id);
  }
}

async function markPaymentFailure(
  supabase: ReturnType<typeof buildSupabaseClient>,
  paiement: PaiementRecord,
  payload: WebhookPayload
) {
  if (paiement.intent_id) {
    await supabase
      .from("signup_intents")
      .update({
        state: "awaiting_payment",
        last_error: "Le paiement a échoué",
        metadata: {
          last_payment_status: payload.status,
          last_payment_error_at: new Date().toISOString(),
        },
      })
      .eq("id", paiement.intent_id);
  }

  if (paiement.abonnement_id) {
    await supabase
      .from("abonnements")
      .update({
        statut: "en_attente",
        updated_at: new Date().toISOString(),
      })
      .eq("id", paiement.abonnement_id);
  }

  await supabase.rpc("refresh_user_subscription_status", { p_user_id: paiement.user_id });
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

  const supabase = buildSupabaseClient();

  try {
    const payload = (await req.json()) as WebhookPayload;
    console.log("[ipay-webhook] Payload reçu", payload);

    if (!payload.status || (!payload.reference && !payload.transaction_id && !payload.paiement_id)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_reference",
          message: "Référence de paiement ou identifiants manquants",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const paiement = await findPaiement(supabase, payload);

    if (!paiement) {
      console.warn("[ipay-webhook] Aucun paiement correspondant au webhook", payload);
      return new Response(
        JSON.stringify({
          success: false,
          error: "payment_not_found",
          message: "Paiement introuvable",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const newStatus = mapStatus(payload.status);

    const { error: updateError } = await supabase
      .from("paiements")
      .update({
        statut: newStatus,
        ipay_status: payload.status,
        ipay_reference: payload.reference ?? paiement.ipay_reference,
        ipay_transaction_id: payload.transaction_id ?? paiement.ipay_transaction_id,
        msisdn: payload.msisdn ?? null,
        currency: payload.currency ?? "XOF",
        last_status_check: new Date().toISOString(),
      })
      .eq("id", paiement.id);

    if (updateError) {
      console.error("[ipay-webhook] Erreur mise à jour paiement", updateError);
      throw new Error(`Erreur lors de la mise à jour du paiement: ${updateError.message}`);
    }

    await recordPaymentEvent(
      supabase,
      paiement.id,
      paiement.user_id,
      newStatus,
      payload,
      paiement.intent_id
    );

    if (newStatus === "confirme") {
      await activateSubscription(supabase, paiement, payload);
      await updatePollingJob(supabase, paiement.id, "completed");
    } else if (newStatus === "echoue") {
      await markPaymentFailure(supabase, paiement, payload);
      await updatePollingJob(supabase, paiement.id, "failed");
    }

    await supabase.from("webhook_logs").insert({
      source: "ipay",
      event_type: "payment_status_update",
      payload,
      status: "processed",
      processed_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Webhook traité avec succès",
        payment_id: paiement.id,
        new_status: newStatus,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[ipay-webhook] Erreur", error);

    await supabase.from("webhook_logs").insert({
      source: "ipay",
      event_type: "payment_status_update",
      payload: await req.clone().json().catch(() => ({})),
      status: "error",
      error_message: error instanceof Error ? error.message : String(error),
      processed_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erreur inconnue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});