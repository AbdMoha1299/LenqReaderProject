import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

interface GenerateTokenPayload {
  pdfId: string;
  reuseExisting?: boolean;
}

interface UserProfile {
  id: string;
  statut_abonnement: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TOKEN_TTL_MINUTES = 30;
const MAX_ACCESS_COUNT = 5;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("[generate-reading-token] Missing Supabase environment configuration.");
}

function buildServiceClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

function createExpirationDate(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "unauthorized",
        message: "Jeton d'authentification manquant",
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const payload = (await req.json()) as GenerateTokenPayload;
    if (!payload?.pdfId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_pdf",
          message: "L'identifiant du PDF est requis",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const accessToken = authHeader.replace("Bearer ", "");
    const serviceClient = buildServiceClient();

    const { data: authUser, error: authError } = await serviceClient.auth.getUser(accessToken);
    if (authError || !authUser?.user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "unauthorized",
          message: "Session invalide ou expirée",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authUserId = authUser.user.id;

    const { data: profile } = await serviceClient
      .from("users")
      .select("id, statut_abonnement")
      .eq("auth_user_id", authUserId)
      .maybeSingle<UserProfile>();

    if (!profile?.id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "profile_not_found",
          message: "Profil utilisateur introuvable",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await serviceClient.rpc("refresh_user_subscription_status", { p_user_id: profile.id });

    const { data: hasAccess } = await serviceClient.rpc("user_has_access_to_edition", {
      p_user_id: profile.id,
      p_pdf_id: payload.pdfId,
    });

    if (!hasAccess) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "access_denied",
          message: "Votre abonnement ne vous permet pas d'accéder à cette édition",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (payload.reuseExisting) {
      const { data: existingToken } = await serviceClient
        .from("tokens")
        .select("token, expires_at")
        .eq("user_id", profile.id)
        .eq("pdf_id", payload.pdfId)
        .eq("revoked", false)
        .gte("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ token: string; expires_at: string }>();

      if (existingToken) {
        return new Response(
          JSON.stringify({
            success: true,
            token: existingToken.token,
            expires_at: existingToken.expires_at,
            reused: true,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const tokenValue = crypto.randomUUID();
    const expiresAt = createExpirationDate(TOKEN_TTL_MINUTES);

    const { error: insertError } = await serviceClient.from("tokens").insert({
      pdf_id: payload.pdfId,
      user_id: profile.id,
      token: tokenValue,
      expires_at: expiresAt,
      used: false,
      max_access_count: MAX_ACCESS_COUNT,
      revoked: false,
      ip_addresses: [],
    });

    if (insertError) {
      throw new Error(`Erreur lors de la création du token: ${insertError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        token: tokenValue,
        expires_at: expiresAt,
        reused: false,
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[generate-reading-token] Unexpected error:", error);
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
