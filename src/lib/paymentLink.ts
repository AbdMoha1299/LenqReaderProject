export interface PaymentLinkResponse {
  success: boolean;
  payment_url?: string;
  reference?: string;
  external_reference?: string;
  message?: string;
  error?: string;
  paiement_id?: string;
}

export async function generatePaymentLink(
  customerName: string,
  amount: number,
  userId: string,
  abonnementId: string,
  country: string = 'BJ'
): Promise<PaymentLinkResponse> {
  try {
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-payment-link`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        customer_name: customerName,
        amount,
        currency: 'XOF',
        country,
        user_id: userId,
        abonnement_id: abonnementId,
        description: `Abonnement L'Enquêteur - ${customerName}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || 'payment_link_failed',
        message: data.message || 'Erreur lors de la création du lien de paiement',
      };
    }

    return data;
  } catch (error) {
    console.error('Error generating payment link:', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Erreur de connexion. Veuillez réessayer.',
    };
  }
}

