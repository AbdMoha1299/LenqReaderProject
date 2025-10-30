import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_API_URL = "https://i-pay.money/api/v1/payments";

type PaymentType = "mobile" | "card" | "sta";

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const {
      customer_name,
      currency,
      country,
      amount,
      transaction_id,
      msisdn,
      payment_type,
      user_id,
      abonnement_id,
    }: PaymentRequest = await req.json();

    if (!customer_name || !currency || !country || !amount || !transaction_id || !payment_type) {
      return jsonResponse(
        {
          success: false,
          error: "missing_fields",
          message: "Tous les champs requis doivent etre fournis",
        },
        400,
      );
    }

    if ((payment_type === "mobile" || payment_type === "sta") && !msisdn) {
      return jsonResponse(
        {
          success: false,
          error: "msisdn_required",
          message: "Le numero de telephone est requis pour ce mode de paiement",
        },
        400,
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ipaySecretKey = Deno.env.get("IPAY_SECRET_KEY");
    const ipayEnvironment = Deno.env.get("IPAY_ENVIRONMENT") ?? "live";

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return jsonResponse(
        {
          success: false,
          error: "configuration_error",
          message: "Configuration Supabase manquante",
        },
        500,
      );
    }

    if (!ipaySecretKey) {
      console.error("Missing iPay secret key");
      return jsonResponse(
        {
          success: false,
          error: "configuration_error",
          message: "Configuration iPay manquante",
        },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

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

    console.log("Sending payment request to iPay:", {
      url: IPAY_API_URL,
      payment_type,
      environment: ipayEnvironment,
      payload: paymentBody,
    });

    const startTime = Date.now();
    const ipayResponse = await fetch(IPAY_API_URL, {
      method: "POST",
      headers: {
        "Ipay-Payment-Type": payment_type,
        "Ipay-Target-Environment": ipayEnvironment,
        Authorization: `Bearer ${ipaySecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentBody),
    });
    const responseTime = Date.now() - startTime;

    const rawResponse = await ipayResponse.text();
    let responseData: Record<string, unknown> = {};
    try {
      responseData = rawResponse ? JSON.parse(rawResponse) : {};
    } catch {
      responseData = { raw: rawResponse };
    }

    console.log("iPay response summary:", {
      status: ipayResponse.status,
      ok: ipayResponse.ok,
      body: responseData,
    });

    let paiementId: string | null = null;

    if (user_id) {
      const paiementPayload: Record<string, unknown> = {
        user_id,
        abonnement_id,
        montant_fcfa: amount,
        methode_paiement: `iPayMoney-${payment_type}`,
        ipay_transaction_id: transaction_id,
        ipay_reference: (responseData.reference as string) || null,
        ipay_status: (responseData.status as string) || null,
        country_code: country,
        currency,
        statut: ipayResponse.ok ? "en_attente" : "echoue",
        notes: `Payment via iPayMoney (${payment_type}) - ${(responseData.status as string) || "initiated"}`,
      };

      if (msisdn) {
        paiementPayload.msisdn = msisdn;
      }

      const { data: paiement, error: paiementError } = await supabase
        .from("paiements")
        .insert(paiementPayload)
        .select()
        .single();

      if (paiementError) {
        console.error("Error creating paiement record:", paiementError);
      } else if (paiement) {
        paiementId = paiement.id as string;
      }
    }

    await supabase.from("payment_api_logs").insert({
      paiement_id: paiementId,
      request_type: "initiate",
      request_url: IPAY_API_URL,
      request_headers: {
        "Ipay-Payment-Type": payment_type,
        "Ipay-Target-Environment": ipayEnvironment,
      },
      request_body: paymentBody,
      response_status: ipayResponse.status,
      response_body: responseData,
      response_time_ms: responseTime,
      error_message: ipayResponse.ok ? null : JSON.stringify(responseData),
    });

    if (!ipayResponse.ok) {
      let errorMessage = "Erreur lors de l'initiation du paiement";

      const responseMessage = (responseData.message as string) || "";
      if (ipayResponse.status === 400) {
        if (responseMessage.includes("Not Allowed Payment Type")) {
          errorMessage = "Service de paiement mobile temporairement indisponible. Veuillez reessayer plus tard.";
        } else if (responseMessage.includes("invalid")) {
          errorMessage = "Numero de telephone invalide ou parametres incorrects";
        } else {
          errorMessage = responseMessage || "Numero de telephone invalide ou parametres incorrects";
        }
      } else if (ipayResponse.status === 401) {
        errorMessage = "Erreur d'authentification du service de paiement";
      } else if (ipayResponse.status === 422) {
        errorMessage = "Reference de transaction invalide";
      }

      return jsonResponse(
        {
          success: false,
          error: "payment_failed",
          message: errorMessage,
          details: responseData,
        },
        ipayResponse.status,
      );
    }

    if (paiementId && responseData.reference) {
      const nextPollAt = new Date(Date.now() + 10_000);

      const { error: jobError } = await supabase.from("payment_polling_jobs").insert({
        paiement_id: paiementId,
        ipay_reference: responseData.reference,
        status: "active",
        polling_count: 0,
        next_poll_at: nextPollAt.toISOString(),
        last_known_status: responseData.status,
      });

      if (jobError) {
        console.error("Unable to enqueue payment polling job:", jobError);
      }
    }

    return jsonResponse({
      success: true,
      status: responseData.status,
      reference: responseData.reference,
      message: "Paiement initie avec succes",
      paiement_id: paiementId,
      payment_url: responseData.payment_url || responseData.redirect_url || null,
    });
  } catch (error) {
    console.error("Error in initiate-payment function:", error);
    return jsonResponse(
      {
        success: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : "Erreur interne du serveur",
      },
      500,
    );
  }
});
