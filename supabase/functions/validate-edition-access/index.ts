import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DeviceFingerprint {
  userAgent: string;
  screenResolution: string;
  timezone: string;
  language: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { token, deviceFingerprint, ipAddress } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Token requis" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: tokenByValue, error: tokenError } = await supabaseClient
      .from("tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (tokenError) {
      console.error("Token query error:", tokenError);
      return new Response(
        JSON.stringify({ error: "Erreur de validation du token" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let tokenData = tokenByValue;

    if (!tokenData) {
      const { data: tokenById, error: tokenIdError } = await supabaseClient
        .from("tokens")
        .select("*")
        .eq("id", token)
        .maybeSingle();

      if (tokenIdError) {
        console.error("Token fallback query error:", tokenIdError);
        return new Response(
          JSON.stringify({ error: "Erreur de validation du token" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      tokenData = tokenById;
    }

    if (!tokenData) {
      return new Response(
        JSON.stringify({ error: "Token invalide" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: "Ce lien a expiré" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (tokenData.revoked) {
      return new Response(
        JSON.stringify({
          error: "Accès révoqué",
          reason: tokenData.revoked_reason || "Partage de lien détecté"
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (tokenData.access_count >= tokenData.max_access_count) {
      return new Response(
        JSON.stringify({ error: "Limite d'accès atteinte" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: pdfData, error: pdfError } = await supabaseClient
      .from("pdfs")
      .select("id, titre, url_fichier, statut_publication")
      .eq("id", tokenData.pdf_id)
      .maybeSingle();

    if (pdfError || !pdfData) {
      console.error("PDF query error:", pdfError);
      return new Response(
        JSON.stringify({ error: "Édition introuvable" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: userData, error: userError } = await supabaseClient
      .from("users")
      .select("id, nom, numero_abonne, statut_abonnement, numero_whatsapp, devices_autorises")
      .eq("id", tokenData.user_id)
      .maybeSingle();

    if (userError || !userData) {
      console.error("User query error:", userError);
      return new Response(
        JSON.stringify({ error: "Utilisateur introuvable" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabaseClient.rpc("refresh_user_subscription_status", {
      p_user_id: tokenData.user_id,
    });

    const { data: hasAccess, error: accessError } = await supabaseClient.rpc("user_has_access_to_edition", {
      p_user_id: tokenData.user_id,
      p_pdf_id: tokenData.pdf_id,
    });

    if (accessError) {
      console.error("Access check error:", accessError);
      return new Response(
        JSON.stringify({ error: "Erreur lors de la vérification des droits d'accès" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!hasAccess) {
      return new Response(
        JSON.stringify({
          error: "Accès refusé",
          reason: "Votre abonnement ne permet pas d'accéder à cette édition.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let suspiciousActivity = false;
    let suspiciousReason = "";

    const fingerprintJson = deviceFingerprint ? JSON.stringify(deviceFingerprint) : null;
    const allowedDevices = Math.max(1, userData.devices_autorises ?? 2);

    const parseStoredFingerprints = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
        }
      } catch {
        // raw is not a JSON array, treat it as a single entry string
      }
      return raw.trim().length > 0 ? [raw] : [];
    };

    const storedFingerprints = parseStoredFingerprints(tokenData.device_fingerprint as string | null);
    let fingerprintList = [...storedFingerprints];
    let fingerprintChanged = false;

    if (fingerprintJson) {
      if (fingerprintList.length === 0) {
        fingerprintList = [fingerprintJson];
        fingerprintChanged = true;
      } else if (!fingerprintList.includes(fingerprintJson)) {
        if (fingerprintList.length >= allowedDevices) {
          suspiciousActivity = true;
          suspiciousReason = "Nombre maximum d'appareils atteint";

          await supabaseClient.from("acces_suspects").insert({
            user_id: tokenData.user_id,
            token_id: tokenData.id,
            type_alerte: "device_multiple",
            description: `Acces detecte depuis un nouvel appareil. Appareils deja observes: ${fingerprintList.join(" || ")}`,
            severity: allowedDevices > 1 ? "high" : "critical",
            data: {
              authorized_devices: fingerprintList,
              new_device: deviceFingerprint,
              ip_address: ipAddress,
            },
          });

          const keepCount = Math.max(allowedDevices - 1, 0);
          const trimmed = keepCount > 0 ? fingerprintList.slice(-keepCount) : [];
          fingerprintList = [...trimmed, fingerprintJson];
        } else {
          fingerprintList.push(fingerprintJson);
        }

        fingerprintChanged = true;
      }
    }

    if (tokenData.ip_addresses && ipAddress) {
      const ipList = tokenData.ip_addresses as string[];
      if (ipList.length > 0 && !ipList.includes(ipAddress)) {
        if (ipList.length >= 5) {
          suspiciousActivity = true;
          suspiciousReason = "Accès depuis plusieurs IP";

          await supabaseClient.from("acces_suspects").insert({
            user_id: tokenData.user_id,
            token_id: tokenData.id,
            type_alerte: "ip_differente",
            description: `Accès depuis une nouvelle IP: ${ipAddress}. IPs précédentes: ${ipList.join(", ")}`,
            severity: "high",
            data: {
              previous_ips: ipList,
              new_ip: ipAddress,
            },
          });
        }
      }
    }

    const updateData: any = {
      access_count: tokenData.access_count + 1,
      last_access_at: new Date().toISOString(),
    };

    if (!tokenData.first_access_at) {
      updateData.first_access_at = new Date().toISOString();
    }

    if (fingerprintChanged || (!tokenData.device_fingerprint && fingerprintList.length > 0)) {
      updateData.device_fingerprint = JSON.stringify(fingerprintList);
    }

    if (ipAddress) {
      const currentIps = (tokenData.ip_addresses as string[]) || [];
      if (!currentIps.includes(ipAddress)) {
        updateData.ip_addresses = [...currentIps.slice(-2), ipAddress];
      }
    }

    await supabaseClient
      .from("tokens")
      .update(updateData)
      .eq("id", tokenData.id);

    const { data: editionData } = await supabaseClient
      .from("editions")
      .select(`
        id,
        titre,
        pages(id, page_number, image_url),
        articles(id, titre, ordre_lecture)
      `)
      .eq("pdf_url", pdfData.url_fichier)
      .in("statut", ["ready", "published"])
      .maybeSingle();

    const { data: signedUrlData, error: signedUrlError } = await supabaseClient.storage
      .from("secure-pdfs")
      .createSignedUrl(pdfData.url_fichier, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Signed URL error:", signedUrlError);
      return new Response(
        JSON.stringify({ error: "Impossible de générer un accès sécurisé au PDF" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (editionData) {
      return new Response(
        JSON.stringify({
          valid: true,
          hasArticles: true,
          editionId: editionData.id,
          editionTitle: editionData.titre,
          pdfUrl: signedUrlData.signedUrl,
          pdfTitle: pdfData.titre,
          userId: userData.id,
          userName: userData.nom,
          userNumber: userData.numero_abonne,
          suspicious: suspiciousActivity,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        hasArticles: false,
        pdfUrl: signedUrlData.signedUrl,
        pdfTitle: pdfData.titre,
        userId: userData.id,
        userName: userData.nom,
        userNumber: userData.numero_abonne,
        suspicious: suspiciousActivity,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error validating token:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erreur inconnue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
