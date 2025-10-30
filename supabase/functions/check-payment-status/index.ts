import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_API_URL = "https://i-pay.money/api/v1/payments";

interface CheckStatusRequest {
  reference: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { reference }: CheckStatusRequest = await req.json();

    if (!reference) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "missing_reference",
          message: "Référence de paiement requise" 
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
    const ipayEnvironment = Deno.env.get("IPAY_ENVIRONMENT") ?? "live";

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase credentials");
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

    const startTime = Date.now();

    const ipayResponse = await fetch(`${IPAY_API_URL}/${reference}`, {
      method: "GET",
      headers: {
        "Ipay-Payment-Type": "mobile",
        "Ipay-Target-Environment": ipayEnvironment,
        "Authorization": `Bearer ${ipaySecretKey}`,
        "Content-Type": "application/json",
      },
    });

    const responseTime = Date.now() - startTime;
    const responseData = await ipayResponse.json();

    const { data: paiement } = await supabase
      .from("paiements")
      .select("*")
      .eq("ipay_reference", reference)
      .maybeSingle();

    if (paiement) {
      await supabase.from("payment_api_logs").insert({
        paiement_id: paiement.id,
        request_type: "check_status",
        request_url: `${IPAY_API_URL}/${reference}`,
        request_headers: {
          "Ipay-Payment-Type": "mobile",
          "Ipay-Target-Environment": ipayEnvironment,
        },
        request_body: { reference },
        response_status: ipayResponse.status,
        response_body: responseData,
        response_time_ms: responseTime,
        error_message: !ipayResponse.ok ? JSON.stringify(responseData) : null,
      });
    }

    if (!ipayResponse.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "status_check_failed",
          message: "Impossible de vérifier le statut du paiement",
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

    if (paiement && responseData.status) {
      let newStatut = paiement.statut;
      
      if (responseData.status === "succeeded") {
        newStatut = "confirme";
      } else if (responseData.status === "failed") {
        newStatut = "echoue";
      }

      await supabase
        .from("paiements")
        .update({
          ipay_status: responseData.status,
          statut: newStatut,
          last_status_check: new Date().toISOString(),
        })
        .eq("id", paiement.id);

      if (responseData.status === "succeeded" && paiement.abonnement_id) {
        await supabase
          .from("abonnements")
          .update({ statut: "actif" })
          .eq("id", paiement.abonnement_id);

        await supabase
          .from("users")
          .update({ statut_abonnement: "actif" })
          .eq("id", paiement.user_id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: responseData,
        message: "Statut du paiement récupéré avec succès",
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
    console.error("Error in check-payment-status function:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : "Erreur interne du serveur",
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
