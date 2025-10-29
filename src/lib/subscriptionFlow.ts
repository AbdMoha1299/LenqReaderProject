import { supabase } from './supabase';
import { normalizePhoneNumber } from './otp';

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
};

export interface StartSignupPayload {
  nom: string;
  numero_whatsapp: string;
  formule_id: string;
  country_code?: string;
}

export interface StartSignupResponse {
  success: boolean;
  error?: string;
  message?: string;
  intentId?: string;
  retryAfter?: number | null;
  expiresInSeconds?: number | null;
}

export interface VerifyOtpResponse {
  success: boolean;
  error?: string;
  message?: string;
  userId?: string;
  intentId?: string;
  requiresPassword?: boolean;
  attemptsRemaining?: number;
}

export interface CompleteSignupResponse {
  success: boolean;
  error?: string;
  message?: string;
  intentId?: string;
  userId?: string;
  authEmail?: string;
  phone?: string;
}

export interface CreatePaymentSessionResponse {
  success: boolean;
  error?: string;
  message?: string;
  mode?: 'free_trial' | 'payment';
  paymentId?: string;
  transactionId?: string;
  amount?: number;
  publicKey?: string;
  environment?: string;
  redirectUrl?: string;
  callbackUrl?: string;
}

function phoneToDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function phoneToAuthEmail(phone: string): string {
  const digits = phoneToDigits(phone);
  return `${digits}@reader.phone`;
}

async function callFunction<T>(
  name: string,
  payload: Record<string, unknown>
): Promise<{ status: number } & Record<string, any>> {
  const response = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return { status: response.status, ...data };
}

export async function startSignup(payload: StartSignupPayload): Promise<StartSignupResponse> {
  try {
    const formattedPhone = normalizePhoneNumber(payload.numero_whatsapp);
    const result = await callFunction<any>('send-otp', {
      numero_whatsapp: formattedPhone,
      nom: payload.nom,
      country_code: payload.country_code,
      formule_id: payload.formule_id,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
        retryAfter: result.retry_after ?? null,
      };
    }

    return {
      success: true,
      message: result.message,
      intentId: result.intent_id,
      retryAfter: result.retry_after ?? null,
      expiresInSeconds: result.expires_in_seconds ?? null,
    };
  } catch (error) {
    console.error('[startSignup] unexpected error', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Impossible de démarrer la procédure. Vérifiez votre connexion.',
    };
  }
}

export async function verifySignupOtp(intentId: string, otpCode: string): Promise<VerifyOtpResponse> {
  try {
    const result = await callFunction<any>('verify-otp', {
      intent_id: intentId,
      otp_code: otpCode,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
        attemptsRemaining: result.attempts_remaining,
      };
    }

    return {
      success: true,
      message: result.message,
      userId: result.user_id,
      intentId: result.intent_id,
      requiresPassword: result.requires_password ?? true,
    };
  } catch (error) {
    console.error('[verifySignupOtp] unexpected error', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Impossible de vérifier le code. Vérifiez votre connexion.',
    };
  }
}

export async function completeSignup(
  intentId: string,
  password: string
): Promise<CompleteSignupResponse> {
  try {
    const result = await callFunction<any>('complete-signup', {
      intent_id: intentId,
      password,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
      };
    }

    return {
      success: true,
      intentId: result.intent_id,
      userId: result.user_id,
      authEmail: result.auth_email,
      phone: result.phone,
    };
  } catch (error) {
    console.error('[completeSignup] unexpected error', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Impossible de créer votre mot de passe. Vérifiez votre connexion.',
    };
  }
}

export async function createPaymentSession(intentId: string): Promise<CreatePaymentSessionResponse> {
  try {
    const result = await callFunction<any>('create-payment', { intent_id: intentId });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
      };
    }

    return {
      success: true,
      mode: result.mode ?? 'payment',
      paymentId: result.payment_id,
      transactionId: result.transaction_id,
      amount: result.amount,
      publicKey: result.public_key,
      environment: result.environment,
      redirectUrl: result.redirect_url,
      callbackUrl: result.callback_url,
      message: result.message,
    };
  } catch (error) {
    console.error('[createPaymentSession] unexpected error', error);
    return {
      success: false,
      error: 'network_error',
      message: 'Impossible de préparer le paiement. Vérifiez votre connexion.',
    };
  }
}

export async function signInAfterCompletion(identifier: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({
    email: identifier,
    password,
  });

  if (error) {
    throw error;
  }
}
