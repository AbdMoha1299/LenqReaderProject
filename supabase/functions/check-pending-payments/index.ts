import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const IPAY_API_URL = "https://api.i-pay.money";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
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
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    // Récupérer tous les paiements en attente de moins de 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: pendingPayments, error: paymentsError } = await supabaseClient
      .from("paiements")
      .select("*")
      .in("statut", ["en_attente", "pending"])
      .gte("created_at", oneDayAgo)
      .order("created_at", { ascending: false });

    if (paymentsError) {
      throw paymentsError;
    }

    if (!pendingPayments || pendingPayments.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Aucun paiement en attente",
          checked: 0,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Vérification de ${pendingPayments.length} paiements en attente...`);

    const results = {
      checked: pendingPayments.length,
      confirmed: 0,
      failed: 0,
      still_pending: 0,
      errors: 0,
    };

    // Vérifier chaque paiement auprès d'iPay
    for (const payment of pendingPayments) {
      try {
        // Appel à l'API iPay pour vérifier le statut
        const checkResponse = await fetch(
          `${IPAY_API_URL}/v1/transactions/${payment.reference}`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${ipaySecretKey}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!checkResponse.ok) {
          console.error(`Erreur API iPay pour ${payment.reference}:`, checkResponse.status);
          results.errors++;
          continue;
        }

        const ipayData = await checkResponse.json();
        console.log(`Statut iPay pour ${payment.reference}:`, ipayData.status);

        // Analyser le statut iPay
        const isSuccess = ipayData.status === "successful" || ipayData.status === "success" || ipayData.status === "completed";
        const isFailed = ipayData.status === "failed" || ipayData.status === "cancelled" || ipayData.status === "expired";

        if (isSuccess) {
          // Confirmer le paiement via RPC
          const { error: confirmError } = await supabaseClient.rpc(
            "confirm_payment",
            {
              p_payment_id: payment.id,
              p_admin_id: null,
              p_ipay_data: ipayData,
            }
          );

          if (confirmError) {
            console.error(`Erreur confirmation ${payment.reference}:`, confirmError);
            results.errors++;
          } else {
            console.log(`✅ Paiement confirmé: ${payment.reference}`);
            results.confirmed++;
          }
        } else if (isFailed) {
          // Marquer comme échoué
          await supabaseClient
            .from("paiements")
            .update({
              statut: "echoue",
              ipay_status: "failed",
              metadata: {
                ...payment.metadata,
                ipay_failure: ipayData,
                checked_at: new Date().toISOString(),
              },
            })
            .eq("id", payment.id);

          await supabaseClient.from("payment_events").insert({
            payment_id: payment.id,
            event_type: "failed",
            actor_id: null,
            actor_type: "system",
            metadata: { reason: ipayData.status, ipay_data: ipayData },
          });

          console.log(`❌ Paiement échoué: ${payment.reference}`);
          results.failed++;
        } else {
          // Toujours en attente
          await supabaseClient
            .from("paiements")
            .update({
              ipay_status: ipayData.status,
              metadata: {
                ...payment.metadata,
                last_check: ipayData,
                checked_at: new Date().toISOString(),
              },
            })
            .eq("id", payment.id);

          console.log(`⏳ Toujours en attente: ${payment.reference}`);
          results.still_pending++;
        }
      } catch (error) {
        console.error(`Erreur pour ${payment.reference}:`, error);
        results.errors++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Vérification terminée",
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error checking pending payments:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erreur inconnue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
