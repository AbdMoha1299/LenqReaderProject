import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type SignupIntentState =
  | "collect_contact"
  | "otp_verified"
  | "awaiting_payment"
  | "active"
  | "expired"
  | "cancelled";

interface SendOtpPayload {
  numero_whatsapp: string;
  nom?: string;
  email?: string;
  formule_id?: string;
  country_code?: string;
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
  metadata: Record<string, unknown> | null;
  otp_attempts: number;
  payment_attempts: number;
}

interface RequestOtpResponse {
  success: boolean;
  error?: string;
  message?: string;
  retry_after?: number;
  otp_code?: string;
  expires_in_seconds?: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const WASENDER_API_URL = "https://wasenderapi.com/api/send-message";
const INTENT_EXPIRATION_MINUTES = 120;
const REUSABLE_STATES: SignupIntentState[] = ["collect_contact", "otp_verified", "awaiting_payment"];

const wasenderApiKey =
  Deno.env.get("WASENDER_API_KEY") ??
  Deno.env.get("VITE_WASENDER_API_KEY") ??
  "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("[send-otp] Missing Supabase credentials in environment variables.");
}

function normalizePhoneNumber(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, "");
  return cleaned.startsWith("+") ? cleaned : `+${cleaned.replace(/^\+/, "")}`;
}

function detectCountryCode(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("229")) return "BJ";
  if (digits.startsWith("227")) return "NE";
  if (digits.startsWith("225")) return "CI";
  if (digits.startsWith("221")) return "SN";
  if (digits.startsWith("228")) return "TG";
  if (digits.startsWith("226")) return "BF";
  if (digits.startsWith("223")) return "ML";
  if (digits.startsWith("233")) return "GH";
  if (digits.startsWith("234")) return "NG";
  return null;
}

function buildSupabaseClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

async function upsertSignupIntent(
  payload: SendOtpPayload,
  normalizedPhone: string,
  ipAddress: string | null,
  userAgent: string | null,
  supabase: ReturnType<typeof buildSupabaseClient>
): Promise<{ intent: SignupIntent; created: boolean }> {
  const country = payload.country_code ?? detectCountryCode(normalizedPhone);
  const metadata: Record<string, unknown> = {
    last_otp_sent_at: new Date().toISOString(),
    last_request_ip: ipAddress,
    last_request_ua: userAgent,
  };

  const { data: existingIntent, error: intentFetchError } = await supabase
    .from("signup_intents")
    .select("*")
    .eq("numero_whatsapp_normalized", normalizedPhone)
    .in("state", REUSABLE_STATES)
    .maybeSingle<SignupIntent>();

  if (intentFetchError) {
    throw new Error(`Erreur lors de la récupération de l'intent: ${intentFetchError.message}`);
  }

  if (existingIntent) {
    if (existingIntent.state === "active") {
      throw new Error("account_already_active");
    }

    const { data, error } = await supabase
      .from("signup_intents")
      .update({
        numero_whatsapp: payload.numero_whatsapp.trim(),
        numero_whatsapp_normalized: normalizedPhone,
        nom: payload.nom ?? existingIntent.nom,
        email: payload.email ?? existingIntent.email,
        country_code: country ?? existingIntent.country_code,
        formule_id: payload.formule_id ?? existingIntent.formule_id,
        state: "collect_contact",
        expires_at: new Date(Date.now() + INTENT_EXPIRATION_MINUTES * 60 * 1000).toISOString(),
        last_error: null,
        metadata: {
          ...(existingIntent.metadata ?? {}),
          ...metadata,
        },
      })
      .eq("id", existingIntent.id)
      .select("*")
      .single<SignupIntent>();

    if (error || !data) {
      throw new Error(`Erreur lors de la mise à jour de l'intent: ${error?.message ?? "unknown"}`);
    }

    return { intent: data, created: false };
  }

  const { data, error } = await supabase
    .from("signup_intents")
    .insert({
      numero_whatsapp: payload.numero_whatsapp.trim(),
      numero_whatsapp_normalized: normalizedPhone,
      nom: payload.nom ?? null,
      email: payload.email ?? null,
      country_code: country,
      formule_id: payload.formule_id ?? null,
      state: "collect_contact",
      expires_at: new Date(Date.now() + INTENT_EXPIRATION_MINUTES * 60 * 1000).toISOString(),
      metadata,
    })
    .select("*")
    .single<SignupIntent>();

  if (error || !data) {
    throw new Error(`Erreur lors de la création de l'intent: ${error?.message ?? "unknown"}`);
  }

  return { intent: data, created: true };
}

async function sendWhatsappMessage(phone: string, message: string) {
  if (!wasenderApiKey) {
    const error = new Error("missing_wasender_key");
    (error as any).userMessage =
      "Configuration WhatsApp absente. Contactez un administrateur.";
    throw error;
  }

  const formattedPhone = phone.startsWith("+") ? phone.slice(1) : phone;

  const response = await fetch(WASENDER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wasenderApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: formattedPhone,
      text: message,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.error || data?.status === "error") {
    const errorMessage =
      typeof data?.message === "string"
        ? data.message
        : response.status === 401
        ? "Clé API WhatsApp invalide"
        : "Envoi WhatsApp impossible";
    const error = new Error("whatsapp_delivery_error");
    (error as any).details = data;
    (error as any).userMessage = errorMessage;
    throw error;
  }

  return data;
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
    const payload = (await req.json()) as SendOtpPayload;
    if (!payload?.numero_whatsapp) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_phone",
          message: "Le numéro WhatsApp est requis",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const normalizedPhone = normalizePhoneNumber(payload.numero_whatsapp);
    const supabase = buildSupabaseClient();

    const ipAddress = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? null;
    const userAgent = req.headers.get("user-agent") ?? null;

    let intent: SignupIntent;
    try {
      ({ intent } = await upsertSignupIntent(payload, normalizedPhone, ipAddress, userAgent, supabase));
    } catch (intentError) {
      if ((intentError as Error).message === "account_already_active") {
        return new Response(
          JSON.stringify({
            success: false,
            error: "already_active",
            message: "Ce compte est déjà actif. Veuillez vous connecter.",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw intentError;
    }

    const otpResultResponse = await supabase.rpc("request_otp", {
      p_numero_whatsapp: normalizedPhone,
      p_ip_address: ipAddress,
      p_user_agent: userAgent,
    });

    if (otpResultResponse.error) {
      throw new Error(`Erreur lors de la génération de l'OTP: ${otpResultResponse.error.message}`);
    }

    const otpResult = otpResultResponse.data as RequestOtpResponse;
    if (!otpResult?.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: otpResult?.error ?? "otp_generation_failed",
          message: otpResult?.message ?? "Impossible de générer le code OTP",
          retry_after: otpResult?.retry_after,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const otpCode = otpResult.otp_code ?? "****";
    const whatsappMessage = `Votre code de vérification L'Enquêteur est : *${otpCode}*\n\nCe code expire dans 10 minutes.\n🔐 Ne partagez ce code avec personne.`;

    try {
      await sendWhatsappMessage(normalizedPhone, whatsappMessage);
    } catch (whatsappError) {
      const err = whatsappError as Error & { details?: unknown; userMessage?: string };
      await supabase
        .from("signup_intents")
        .update({
          last_error: err.userMessage ?? "Erreur lors de l'envoi du message WhatsApp",
          metadata: {
            ...(intent.metadata ?? {}),
            last_otp_error: {
              at: new Date().toISOString(),
              details: err.details ?? null,
            },
          },
        })
        .eq("id", intent.id);

      return new Response(
        JSON.stringify({
          success: false,
          error: "whatsapp_error",
          message: err.userMessage ?? "Erreur lors de l'envoi du message WhatsApp",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase
      .from("signup_intents")
      .update({
        otp_attempts: 0,
        last_error: null,
        metadata: {
          ...(intent.metadata ?? {}),
          last_otp_sent_at: new Date().toISOString(),
        },
      })
      .eq("id", intent.id);

    return new Response(
      JSON.stringify({
        success: true,
        intent_id: intent.id,
        state: "collect_contact",
        message: "Code OTP envoyé avec succès sur WhatsApp",
        retry_after: otpResult.retry_after ?? null,
        expires_in_seconds: otpResult.expires_in_seconds ?? 600,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[send-otp] Unexpected error:", error);
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
