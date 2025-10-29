import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_API_URL = "https://i-pay.money/api/v1/payments";
const IPAY_SECRET_KEY = "sk_11a35c3f7ab44dc79e38757fcd28ba82";

type PaymentType = 'mobile' | 'card' | 'sta';

interface PaymentRequest {
  customer_name: string;
  currency: string;
  country: string;
  amount: number;
  transaction_id: string;
  msisdn?: string;
  payment_type: PaymentType;
  user_id?: string;
  abonnement_id?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const requestBody: PaymentRequest = await req.json();
    const { customer_name, currency, country, amount, transaction_id, msisdn, payment_type, user_id, abonnement_id } = requestBody;

    if (!customer_name || !currency || !country || !amount || !transaction_id || !payment_type) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_fields",
          message: "Tous les champs requis doivent être fournis"
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

    if ((payment_type === 'mobile' || payment_type === 'sta') && !msisdn) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "msisdn_required",
          message: "Le numéro de téléphone est requis pour ce mode de paiement"
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const startTime = Date.now();

    const paymentBody: Record<string, string> = {
      customer_name,
      currency,
      country,
      amount: amount.toString(),
      transaction_id,
    };

    if (msisdn) {
      paymentBody.msisdn = msisdn;
    }

    console.log("📤 Sending to iPay:", {
      url: IPAY_API_URL,
      headers: {
        "Ipay-Payment-Type": payment_type,
        "Ipay-Target-Environment": "live",
      },
      body: paymentBody,
    });

    const ipayResponse = await fetch(IPAY_API_URL, {
      method: "POST",
      headers: {
        "Ipay-Payment-Type": payment_type,
        "Ipay-Target-Environment": "live",
        "Authorization": `Bearer ${IPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentBody),
    });

    const responseTime = Date.now() - startTime;
    const responseData = await ipayResponse.json();

    console.log("📥 iPay Response:", {
      status: ipayResponse.status,
      ok: ipayResponse.ok,
      data: responseData,
    });

    let paiementId: string | null = null;

    if (user_id) {
      const paiementData: any = {
        user_id,
        abonnement_id,
        montant_fcfa: amount,
        methode_paiement: `iPayMoney-${payment_type}`,
        ipay_transaction_id: transaction_id,
        ipay_reference: responseData.reference || null,
        ipay_status: responseData.status || null,
        country_code: country,
        currency,
        statut: ipayResponse.ok ? "en_attente" : "echoue",
        notes: `Payment via iPayMoney (${payment_type}) - ${responseData.status || 'initiated'}`,
      };

      if (msisdn) {
        paiementData.msisdn = msisdn;
      }

      const { data: paiement, error: paiementError } = await supabase
        .from("paiements")
        .insert(paiementData)
        .select()
        .single();

      if (!paiementError && paiement) {
        paiementId = paiement.id;
      }
    }

    await supabase.from("payment_api_logs").insert({
      paiement_id: paiementId,
      request_type: "initiate",
      request_url: IPAY_API_URL,
      request_headers: {
        "Ipay-Payment-Type": payment_type,
        "Ipay-Target-Environment": "live",
      },
      request_body: paymentBody,
      response_status: ipayResponse.status,
      response_body: responseData,
      response_time_ms: responseTime,
      error_message: !ipayResponse.ok ? JSON.stringify(responseData) : null,
    });

    if (!ipayResponse.ok) {
      let errorMessage = "Erreur lors de l'initiation du paiement";

      if (ipayResponse.status === 400) {
        if (responseData.message?.includes("Not Allowed Payment Type")) {
          errorMessage = "Service de paiement mobile temporairement indisponible. Veuillez réessayer plus tard.";
        } else if (responseData.message?.includes("invalid")) {
          errorMessage = "Numéro de téléphone invalide ou paramètres incorrects";
        } else {
          errorMessage = responseData.message || "Numéro de téléphone invalide ou paramètres incorrects";
        }
      } else if (ipayResponse.status === 401) {
        errorMessage = "Erreur d'authentification du service de paiement";
      } else if (ipayResponse.status === 422) {
        errorMessage = "Référence de transaction invalide";
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: "payment_failed",
          message: errorMessage,
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

    if (paiementId && responseData.reference) {
      const nextPollAt = new Date(Date.now() + 10000);

      await supabase.from("payment_polling_jobs").insert({
        paiement_id: paiementId,
        ipay_reference: responseData.reference,
        status: "active",
        polling_count: 0,
        next_poll_at: nextPollAt.toISOString(),
        last_known_status: responseData.status,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: responseData.status,
        reference: responseData.reference,
        message: "Paiement initié avec succès",
        paiement_id: paiementId,
        payment_url: responseData.payment_url || responseData.redirect_url || null,
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
    console.error("Error in initiate-payment function:", error);
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