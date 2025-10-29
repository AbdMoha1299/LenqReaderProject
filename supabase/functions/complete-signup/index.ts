import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

interface CompleteSignupRequest {
  intent_id: string;
  password: string;
}

type IntentState =
  | "collect_contact"
  | "otp_verified"
  | "awaiting_payment"
  | "active"
  | "expired"
  | "cancelled";

interface SignupIntent {
  id: string;
  state: IntentState;
  user_id: string | null;
  numero_whatsapp: string;
  numero_whatsapp_normalized: string;
  nom: string | null;
  metadata: Record<string, unknown> | null;
  payment_attempts: number;
}

interface UserProfile {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  nom: string | null;
  numero_whatsapp: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("[complete-signup] Missing Supabase credentials in environment.");
}

function buildServiceClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

function phoneToDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function phoneToAuthEmail(phone: string): string {
  return `${phoneToDigits(phone)}@reader.phone`;
}

async function findAuthUserByEmail(
  admin: ReturnType<typeof buildServiceClient>["auth"]["admin"],
  email: string
): Promise<{ id: string } | null> {
  let page = 1;
  const perPage = 100;
  const target = email.toLowerCase();

  while (page <= 20) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error) {
      console.warn("[complete-signup] listUsers error:", error);
      break;
    }

    const match = data.users.find((user) => (user.email ?? "").toLowerCase() === target);
    if (match) {
      return { id: match.id };
    }

    if (data.users.length < perPage) {
      break;
    }

    page += 1;
  }

  return null;
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
    const payload = (await req.json()) as CompleteSignupRequest;
    if (!payload?.intent_id || !payload?.password) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "missing_fields",
          message: "intent_id et password sont requis",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = buildServiceClient();

    const { data: intent, error: intentError } = await supabase
      .from("signup_intents")
      .select(
        `
          *,
          users:user_id (
            id,
            auth_user_id,
            email,
            nom,
            numero_whatsapp
          )
        `
      )
      .eq("id", payload.intent_id)
      .maybeSingle<SignupIntent & { users: UserProfile | null }>();

    if (intentError) {
      throw new Error(`Erreur lors de la récupération de l'intent: ${intentError.message}`);
    }

    if (!intent) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "intent_not_found",
          message: "Intention d'inscription introuvable",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!["otp_verified", "awaiting_payment"].includes(intent.state)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "invalid_state",
          message: "Cette inscription n'est pas prête pour la création du mot de passe",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!intent.user_id) {
      throw new Error("Aucun utilisateur associé à cette intention.");
    }

    const profile = intent.users;
    if (!profile) {
      throw new Error("Profil utilisateur introuvable pour cette intention.");
    }

    const normalizedPhone = intent.numero_whatsapp_normalized ?? intent.numero_whatsapp;
    if (!normalizedPhone) {
      throw new Error("Numéro WhatsApp introuvable pour cette intention.");
    }

    const authEmail = phoneToAuthEmail(normalizedPhone);

    let authUserId = profile.auth_user_id;

    if (!authUserId) {
      const existingAuth = await findAuthUserByEmail(supabase.auth.admin, authEmail);
      if (existingAuth?.id) {
        authUserId = existingAuth.id;
      }
    }

    if (authUserId) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(authUserId, {
        password: payload.password,
        email: authEmail,
        phone: normalizedPhone,
        phone_confirm: true,
        email_confirm: true,
      });

      if (updateError) {
        throw new Error(`Erreur mise à jour utilisateur Auth: ${updateError.message}`);
      }
    } else {
      const { data: newAuth, error: createError } = await supabase.auth.admin.createUser({
        email: authEmail,
        password: payload.password,
        email_confirm: true,
        phone: normalizedPhone,
        phone_confirm: true,
        user_metadata: {
          nom: intent.nom ?? profile.nom ?? null,
          numero_whatsapp: normalizedPhone,
          intent_id: intent.id,
        },
      });

      if (createError || !newAuth?.user) {
        throw new Error(
          `Erreur lors de la création de l'utilisateur Auth: ${createError?.message ?? "unknown"}`
        );
      }

      authUserId = newAuth.user.id;
    }

    await supabase
      .from("users")
      .update({
        auth_user_id: authUserId,
        email: authEmail,
        nom: intent.nom ?? profile.nom ?? null,
        numero_whatsapp: normalizedPhone,
        whatsapp_verifie: true,
      })
      .eq("id", profile.id);

    await supabase
      .from("signup_intents")
      .update({
        state: "awaiting_payment",
        last_error: null,
        metadata: {
          ...(intent.metadata ?? {}),
          password_set_at: new Date().toISOString(),
          auth_user_id: authUserId,
        },
      })
      .eq("id", intent.id);

    return new Response(
      JSON.stringify({
        success: true,
        intent_id: intent.id,
        user_id: profile.id,
        auth_email: authEmail,
        phone: normalizedPhone,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[complete-signup] Unexpected error:", error);
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
