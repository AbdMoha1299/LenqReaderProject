import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const WASENDER_API_URL = "https://wasenderapi.com/api/send-message";

interface SendMessageRequest {
  to: string;
  text: string;
}

interface WasenderResponse {
  success: boolean;
  message?: string;
  error?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { to, text }: SendMessageRequest = await req.json();

    if (!to || !text) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Missing required fields: to and text" 
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

    const apiKey = Deno.env.get("WASENDER_API_KEY");

    if (!apiKey) {
      console.error("Missing Wasender API key");
      return new Response(
        JSON.stringify({
          success: false,
          error: "configuration_error",
          message: "Configuration Wasender manquante",
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

    const response = await fetch(WASENDER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        text,
      }),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error("WasenderApi error:", responseData);
      return new Response(
        JSON.stringify({
          success: false,
          error: responseData.message || "Failed to send WhatsApp message",
          details: responseData,
        }),
        {
          status: response.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "WhatsApp message sent successfully",
        data: responseData,
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
    console.error("Error in send-whatsapp function:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
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
