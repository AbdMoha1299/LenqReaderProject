import { supabase } from './supabase';

export type PaymentType = 'mobile' | 'card' | 'sta';

export interface PaymentRequest {
  customer_name: string;
  currency: string;
  country: string;
  amount: number;
  transaction_id: string;
  msisdn?: string;
  payment_type: PaymentType;
}

export interface PaymentResponse {
  success: boolean;
  status?: 'succeeded' | 'failed' | 'pending';
  reference?: string;
  message?: string;
  error?: string;
  payment_url?: string;
}

export interface PaymentStatusResponse {
  external_reference: string;
  reference: string;
  status: 'succeeded' | 'failed' | 'pending';
  msisdn: string;
}

export function generateTransactionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

export function detectCountryFromPhone(msisdn: string): string {
  if (msisdn.startsWith('229') || msisdn.startsWith('+229')) {
    return 'BJ';
  }
  if (msisdn.startsWith('227') || msisdn.startsWith('+227')) {
    return 'NE';
  }
  return 'BJ';
}

export async function initiatePayment(
  customerName: string,
  amount: number,
  paymentType: PaymentType,
  userId: string,
  abonnementId: string,
  msisdn?: string
): Promise<PaymentResponse> {
  try {
    if ((paymentType === 'mobile' || paymentType === 'sta') && !msisdn) {
      return {
        success: false,
        error: 'msisdn_required',
        message: 'Le numéro de téléphone est requis pour ce mode de paiement',
      };
    }

    const transactionId = generateTransactionId();
    const country = msisdn ? detectCountryFromPhone(msisdn) : 'BJ';

    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/initiate-payment`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        customer_name: customerName,
        currency: 'XOF',
        country,
        amount,
        transaction_id: transactionId,
        msisdn,
        payment_type: paymentType,
        user_id: userId,
        abonnement_id: abonnementId,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error || 'payment_failed',
        message: data.message || 'Échec de l\'initiation du paiement',
      };
    }

    return data;
  } catch (error) {
    console.error('Error initiating payment:', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Erreur de connexion. Veuillez réessayer.',
    };
  }
}

export async function checkPaymentStatus(reference: string): Promise<PaymentStatusResponse | null> {
  try {
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-payment-status`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ reference }),
    });

    if (!response.ok) {
      console.error('Failed to check payment status');
      return null;
    }

    const data = await response.json();
    return data.success ? data.data : null;
  } catch (error) {
    console.error('Error checking payment status:', error);
    return null;
  }
}

export async function subscribeToPaymentUpdates(
  paiementId: string,
  callback: (status: string) => void
): Promise<() => void> {
  const channel = supabase
    .channel(`payment:${paiementId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'paiements',
        filter: `id=eq.${paiementId}`,
      },
      (payload) => {
        if (payload.new && 'statut' in payload.new) {
          callback(payload.new.statut as string);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export const IPAY_TEST_NUMBERS = {
  success: '40410000000',
  success2: '40410000001',
  error: '40410000002',
  error2: '40410000003',
  insufficient_fund: '40410000004',
  insufficient_fund2: '40410000005',
  declined: '40410000006',
  declined2: '40410000007',
  pending: '40410000008',
  pending2: '40410000009',
};

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getPaymentStatusColor(status: string): string {
  switch (status) {
    case 'succeeded':
    case 'confirme':
      return 'text-green-400';
    case 'pending':
    case 'en_attente':
      return 'text-amber-400';
    case 'failed':
    case 'echoue':
    case 'declined':
      return 'text-red-400';
    default:
      return 'text-gray-400';
  }
}

export function getPaymentStatusText(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'Paiement réussi';
    case 'confirme':
      return 'Confirmé';
    case 'pending':
      return 'En attente';
    case 'en_attente':
      return 'En attente de confirmation';
    case 'failed':
      return 'Échec du paiement';
    case 'echoue':
      return 'Échoué';
    case 'declined':
      return 'Paiement refusé';
    case 'insufficient_fund':
      return 'Fonds insuffisants';
    default:
      return status;
  }
}

