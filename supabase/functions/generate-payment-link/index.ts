import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_API_URL = "https://i-pay.money/api/v1/payment-links";

interface PaymentLinkRequest {
  customer_name: string;
  amount: number;
  currency: string;
  country: string;
  user_id: string;
  abonnement_id: string;
  description?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const {
      customer_name,
      amount,
      currency,
      country,
      user_id,
      abonnement_id,
      description,
    }: PaymentLinkRequest = await req.json();

    if (!customer_name || !amount || !currency || !country || !user_id || !abonnement_id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_fields",
          message: "Tous les champs requis doivent etre fournis",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ipaySecretKey = Deno.env.get("IPAY_SECRET_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({
          success: false,
          error: "configuration_error",
          message: "Configuration Supabase manquante",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (!ipaySecretKey) {
      console.error("Missing iPay secret key");
      return new Response(
        JSON.stringify({
          success: false,
          error: "configuration_error",
          message: "Configuration iPay manquante",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const externalReference = `ABN-${abonnement_id}`;

    const paymentLinkBody = {
      customer_name,
      amount: amount.toString(),
      currency,
      country,
      external_reference: externalReference,
      description: description || `Abonnement L'Enqueteur - ${customer_name}`,
    };

    console.log("Creating iPay payment link:", paymentLinkBody);

    const ipayResponse = await fetch(IPAY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ipaySecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentLinkBody),
    });

    const responseData = await ipayResponse.json();

    console.log("iPay payment link response:", {
      status: ipayResponse.status,
      ok: ipayResponse.ok,
      data: responseData,
    });

    if (!ipayResponse.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "payment_link_failed",
          message: responseData.message || "Erreur lors de la creation du lien de paiement",
          details: responseData,
        }),
        {
          status: ipayResponse.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const { data: paiement, error: paiementError } = await supabase
      .from("paiements")
      .insert({
        user_id,
        abonnement_id,
        montant_fcfa: amount,
        methode_paiement: "iPayMoney-link",
        ipay_reference: responseData.reference || null,
        ipay_transaction_id: externalReference,
        country_code: country,
        currency,
        statut: "en_attente",
        notes: `Payment link created - ${responseData.status || "pending"}`,
      })
      .select()
      .single();

    if (paiementError) {
      console.error("Error creating paiement record:", paiementError);
    }

    await supabase.from("payment_api_logs").insert({
      paiement_id: paiement?.id || null,
      request_type: "create_link",
      request_url: IPAY_API_URL,
      request_body: paymentLinkBody,
      response_status: ipayResponse.status,
      response_body: responseData,
      response_time_ms: 0,
    });

    const paymentUrl =
      responseData.payment_url ||
      responseData.url ||
      responseData.link ||
      responseData.redirect_url ||
      responseData.payment_link;

    console.log("Payment URL extracted:", paymentUrl);
    console.log("Full response data:", JSON.stringify(responseData, null, 2));

    if (!paymentUrl) {
      console.error("No payment URL found in response. Available keys:", Object.keys(responseData));
    }

    return new Response(
      JSON.stringify({
        success: true,
        payment_url: paymentUrl,
        reference: responseData.reference,
        external_reference: externalReference,
        message: "Lien de paiement cree avec succes",
        paiement_id: paiement?.id,
        debug_response: responseData,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error in generate-payment-link:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : "Erreur interne",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
