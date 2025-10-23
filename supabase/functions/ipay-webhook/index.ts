import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface IPayWebhookPayload {
  transaction_id: string;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  phone_number?: string;
  operator?: string;
  timestamp?: string;
  metadata?: any;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const payload: IPayWebhookPayload = await req.json();
    
    console.log("iPay Webhook received:", payload);

    if (!payload.reference) {
      return new Response(
        JSON.stringify({ error: "Reference manquante" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Récupérer le paiement par référence
    const { data: payment, error: paymentError } = await supabaseClient
      .from("paiements")
      .select("*")
      .eq("reference", payload.reference)
      .maybeSingle();

    if (paymentError || !payment) {
      console.error("Payment not found:", paymentError);
      return new Response(
        JSON.stringify({ error: "Paiement introuvable", reference: payload.reference }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Logger l'événement webhook
    await supabaseClient.from("payment_events").insert({
      payment_id: payment.id,
      event_type: "webhook_received",
      actor_id: null,
      actor_type: "webhook",
      metadata: {
        ipay_payload: payload,
        timestamp: new Date().toISOString(),
      },
    });

    // Vérifier le statut du paiement
    const isSuccess = payload.status === "successful" || payload.status === "success" || payload.status === "completed";
    const isFailed = payload.status === "failed" || payload.status === "cancelled" || payload.status === "expired";

    if (isSuccess && payment.statut !== "confirme") {
      // Confirmer le paiement via la fonction RPC
      const { data: confirmResult, error: confirmError } = await supabaseClient.rpc(
        "confirm_payment",
        {
          p_payment_id: payment.id,
          p_admin_id: null,
          p_ipay_data: {
            transaction_id: payload.transaction_id,
            reference: payload.reference,
            amount: payload.amount,
            currency: payload.currency,
            status: payload.status,
            phone_number: payload.phone_number,
            operator: payload.operator,
            timestamp: payload.timestamp,
          },
        }
      );

      if (confirmError) {
        console.error("Error confirming payment:", confirmError);
        throw confirmError;
      }

      console.log("Payment confirmed successfully:", confirmResult);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Paiement confirmé avec succès",
          result: confirmResult,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else if (isFailed && payment.statut === "en_attente") {
      // Marquer le paiement comme échoué
      await supabaseClient
        .from("paiements")
        .update({
          statut: "echoue",
          ipay_status: "failed",
          metadata: {
            ...payment.metadata,
            ipay_failure: payload,
            failed_at: new Date().toISOString(),
          },
        })
        .eq("id", payment.id);

      await supabaseClient.from("payment_events").insert({
        payment_id: payment.id,
        event_type: "failed",
        actor_id: null,
        actor_type: "webhook",
        metadata: { reason: payload.status, ipay_data: payload },
      });

      console.log("Payment marked as failed:", payment.id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Paiement marqué comme échoué",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      // Statut intermédiaire (pending, processing, etc.)
      await supabaseClient
        .from("paiements")
        .update({
          ipay_status: payload.status,
          metadata: {
            ...payment.metadata,
            last_ipay_update: payload,
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", payment.id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Statut mis à jour",
          status: payload.status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Error processing iPay webhook:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erreur inconnue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});