import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_PUBLIC_KEY = Deno.env.get("IPAY_PUBLIC_KEY") ?? "pk_0ac56b86849d4fdca1e44df11a7328e0";

interface InitiatePaymentRequest {
  user_id: string;
  formule_id: string;
  country_code?: string;
  currency?: string;
  phone_number?: string;
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

    // Obtenir l'utilisateur authentifié
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authentification requise" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Utilisateur non authentifié" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const requestData: InitiatePaymentRequest = await req.json();

    // Vérifier que l'utilisateur initie son propre paiement
    if (requestData.user_id !== user.id) {
      return new Response(
        JSON.stringify({ error: "Vous ne pouvez initier que vos propres paiements" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initier l'abonnement et le paiement via RPC
    const { data: initResult, error: initError } = await supabaseClient.rpc(
      "initiate_subscription_payment",
      {
        p_user_id: requestData.user_id,
        p_formule_id: requestData.formule_id,
        p_country_code: requestData.country_code ?? "SN",
        p_currency: requestData.currency ?? "XOF",
      }
    );

    if (initError) {
      console.error("Error initiating payment:", initError);
      throw initError;
    }

    console.log("Payment initiated:", initResult);

    // Construire la configuration iPay pour le frontend
    const ipayConfig = {
      publicKey: IPAY_PUBLIC_KEY,
      amount: initResult.amount,
      currency: initResult.currency,
      transactionId: initResult.transaction_ref,
      environment: "live",
      redirectUrl: `${req.headers.get("origin") ?? ""}/payment-status?ref=${initResult.transaction_ref}`,
      callbackUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/ipay-webhook`,
      metadata: {
        user_id: requestData.user_id,
        formule_id: requestData.formule_id,
        payment_id: initResult.payment_id,
        subscription_id: initResult.subscription_id,
      },
    };

    return new Response(
      JSON.stringify({
        success: true,
        payment: initResult,
        ipay_config: ipayConfig,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error initiating payment:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erreur inconnue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});