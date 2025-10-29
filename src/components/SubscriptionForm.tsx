import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Newspaper, ArrowLeft, CheckCircle, Loader, Phone, User, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Formule } from '../lib/supabase';
import { OTPInput } from './OTPInput';
import { validatePhoneNumber, normalizePhoneNumber, detectCountryCode } from '../lib/otp';
import {
  startSignup,
  verifySignupOtp,
  completeSignup,
  createPaymentSession,
  signInAfterCompletion,
} from '../lib/subscriptionFlow';

type Step = 'form' | 'otp' | 'password' | 'payment' | 'success';

interface PaymentSession {
  paymentId: string;
  transactionId: string;
  amount: number;
  publicKey: string;
  environment: string;
  redirectUrl: string;
  callbackUrl: string;
}

export function SubscriptionForm() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const formuleId = searchParams.get('formule');

  const [formule, setFormule] = useState<Formule | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const [step, setStep] = useState<Step>('form');
  const [formData, setFormData] = useState({
    nom: '',
    numero_whatsapp: '',
    country_code: 'BJ',
  });

  const [normalizedPhone, setNormalizedPhone] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [otpSecondsRemaining, setOtpSecondsRemaining] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  const [ipayScriptLoaded, setIpayScriptLoaded] = useState(false);

  useEffect(() => {
    if (formuleId) {
      loadFormule(formuleId);
    } else {
      setLoading(false);
    }
  }, [formuleId]);

  useEffect(() => {
    let timer: number | undefined;
    if (step === 'otp' && otpSecondsRemaining && otpSecondsRemaining > 0) {
      timer = window.setInterval(() => {
        setOtpSecondsRemaining((prev) => (prev && prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [step, otpSecondsRemaining]);

  useEffect(() => {
    if (!paymentSession || ipayScriptLoaded) return;

    const existing = document.querySelector<HTMLScriptElement>('script[data-ipay-sdk="true"]');
    if (existing) {
      setIpayScriptLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://i-pay.money/checkout.js';
    script.async = true;
    script.dataset.ipaySdk = 'true';
    script.onload = () => setIpayScriptLoaded(true);
    script.onerror = () => {
      setError("Impossible de charger le module iPay. Veuillez réessayer ultérieurement.");
      setPaymentSession(null);
    };
    document.body.appendChild(script);
  }, [paymentSession, ipayScriptLoaded]);

  const loadFormule = async (id: string) => {
    try {
      const { data, error } = await supabase
        .from('formules')
        .select('*')
        .eq('id', id)
        .eq('actif', true)
        .maybeSingle<Formule>();

      if (error) throw error;
      setFormule(data || null);
    } catch (err) {
      console.error('Erreur chargement formule:', err);
      setError('Erreur lors du chargement de la formule');
    } finally {
      setLoading(false);
    }
  };

  const validateForm = () => {
    if (!formule) {
      setError('Veuillez sélectionner une formule');
      return false;
    }
    if (!formData.nom || formData.nom.length < 2) {
      setError('Veuillez entrer un nom valide (minimum 2 caractères)');
      return false;
    }
    if (!validatePhoneNumber(formData.numero_whatsapp)) {
      setError('Veuillez entrer un numéro WhatsApp valide (format international)');
      return false;
    }
    return true;
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPaymentSession(null);
    setSuccessMessage('');

    if (!validateForm() || !formule) return;

    setProcessing(true);
    try {
      const formattedPhone = normalizePhoneNumber(formData.numero_whatsapp);
      const country = detectCountryCode(formattedPhone) ?? formData.country_code;
      const response = await startSignup({
        nom: formData.nom,
        numero_whatsapp: formattedPhone,
        formule_id: formule.id,
        country_code: country,
      });

      if (!response.success || !response.intentId) {
        setError(response.message || "Impossible d'envoyer le code OTP. Veuillez réessayer.");
        return;
      }

      setIntentId(response.intentId);
      setNormalizedPhone(formattedPhone);
      setOtpSecondsRemaining(response.expiresInSeconds ?? 600);
      setStep('otp');
    } catch (err: any) {
      console.error('Erreur inscription:', err);
      setError(err.message || 'Une erreur est survenue.');
    } finally {
      setProcessing(false);
    }
  };

  const handleOTPComplete = async (otpCode: string) => {
    if (!intentId) return;
    setProcessing(true);
    setError('');

    try {
      const result = await verifySignupOtp(intentId, otpCode);

      if (!result.success) {
        setError(result.message || 'Code OTP incorrect');
        return;
      }

      setStep(result.requiresPassword === false ? 'payment' : 'password');
    } catch (err: any) {
      console.error('Erreur vérification OTP:', err);
      setError(err.message || 'Vérification impossible. Réessayez.');
    } finally {
      setProcessing(false);
    }
  };

  const handleCancelOTP = () => {
    setIntentId(null);
    setNormalizedPhone(null);
    setOtpSecondsRemaining(null);
    setError('Inscription annulée. Vous pouvez recommencer.');
    setStep('form');
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!intentId || !normalizedPhone) {
      setError('Session invalide. Merci de recommencer.');
      setStep('form');
      return;
    }

    if (password.length < 8) {
      setError('Le mot de passe doit contenir au minimum 8 caractères.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }

    setProcessing(true);
    try {
      const completion = await completeSignup(intentId, password);
      if (!completion.success || !completion.authEmail) {
        setError(completion.message || "Erreur lors de la création du compte.");
        return;
      }

      await signInAfterCompletion(completion.authEmail, password);
      setStep('payment');
    } catch (err: any) {
      console.error('Erreur création mot de passe:', err);
      setError(err.message || 'Impossible de créer votre compte. Réessayez.');
    } finally {
      setProcessing(false);
    }
  };

  const handlePaymentStart = async () => {
    if (!intentId || !formule) return;
    setProcessing(true);
    setError('');
    setPaymentSession(null);
    setSuccessMessage('');

    try {
      const result = await createPaymentSession(intentId);
      if (!result.success) {
        setError(result.message || 'Le paiement a échoué. Réessayez.');
        return;
      }

      if (result.mode === 'free_trial') {
        setSuccessMessage(
          formule.essai_gratuit
            ? 'Votre période gratuite est active. Vous pouvez accéder à vos éditions.'
            : 'Paiement confirmé. Vous pouvez accéder à vos éditions.'
        );
        setStep('success');
        return;
      }

      if (
        !result.paymentId ||
        !result.transactionId ||
        !result.publicKey ||
        typeof result.amount !== 'number'
      ) {
        setError("Impossible de préparer la transaction iPay. Veuillez réessayer.");
        return;
      }

      setPaymentSession({
        paymentId: result.paymentId,
        transactionId: result.transactionId,
        amount: result.amount,
        publicKey: result.publicKey,
        environment: result.environment ?? 'live',
        redirectUrl: result.redirectUrl ?? window.location.href,
        callbackUrl: result.callbackUrl ?? '',
      });
      setStep('payment');
    } catch (err: any) {
      console.error('Erreur préparation paiement:', err);
      setError(err.message || 'Une erreur est survenue lors du paiement');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-black">
        <Loader className="animate-spin text-amber-500 w-10 h-10" />
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-black p-4">
        <div className="bg-gray-800 border border-green-700 rounded-lg p-8 text-center max-w-md">
          <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-4">Inscription réussie !</h2>
          <p className="text-gray-300">{successMessage}</p>
          <button
            onClick={() => navigate('/reader')}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-black font-semibold rounded-lg"
          >
            Accéder à mes éditions
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
      <header className="border-b border-gray-700 bg-gray-900/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Newspaper className="w-8 h-8 text-amber-500" />
            <div>
              <h1 className="text-2xl font-bold text-white">L'Enquêteur</h1>
              <p className="text-xs text-gray-400">Inscription</p>
            </div>
          </div>
          <Link to="/" className="flex items-center gap-2 text-gray-300 hover:text-white">
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Retour</span>
          </Link>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-12">
        {formule && (
          <div className="bg-gray-800 border border-amber-500/30 rounded-lg p-6 mb-8">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-white">{formule.nom}</h3>
                <p className="text-gray-400 text-sm">{formule.description}</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-amber-500">
                  {formule.prix_fcfa === 0 ? 'Gratuit' : `${formule.prix_fcfa.toLocaleString()} FCFA`}
                </div>
                <p className="text-gray-400 text-sm">{formule.duree_jours} jours</p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-gray-800 border border-gray-700 rounded-lg p-8">
          <h2 className="text-2xl font-bold text-white mb-6">
            {step === 'form'
              ? 'Créer mon compte'
              : step === 'otp'
              ? 'Vérification du numéro'
              : step === 'password'
              ? 'Sécurisez votre compte'
              : 'Finaliser mon paiement'}
          </h2>

          {error && (
            <div className="mb-6 bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          {step === 'form' && (
            <form onSubmit={handleFormSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  <User className="inline w-4 h-4 mr-2" /> Nom complet
                </label>
                <input
                  type="text"
                  value={formData.nom}
                  onChange={(e) => setFormData({ ...formData, nom: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-amber-500"
                  placeholder="Jean Dupont"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  <Phone className="inline w-4 h-4 mr-2" /> Numéro WhatsApp
                </label>
                <input
                  type="tel"
                  value={formData.numero_whatsapp}
                  onChange={(e) => setFormData({ ...formData, numero_whatsapp: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-amber-500"
                  placeholder="+227 98 76 54 32"
                  required
                />
                <p className="text-gray-500 text-xs mt-1">
                  Format international requis (ex : +227 pour le Niger). Ce numéro sera votre identifiant.
                </p>
              </div>

              <button
                type="submit"
                disabled={processing}
                className="w-full bg-gradient-to-r from-amber-500 to-yellow-600 text-black font-bold py-4 rounded-lg hover:from-amber-600 hover:to-yellow-700 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {processing ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" /> Envoi du code...
                  </>
                ) : (
                  'Continuer'
                )}
              </button>
            </form>
          )}

          {step === 'otp' && intentId && (
            <div className="space-y-6 text-center">
              <p className="text-gray-300">Code envoyé à</p>
              <p className="text-white font-semibold">{formData.numero_whatsapp}</p>
              <p className="text-sm text-gray-400">
                Ce code est valable {otpSecondsRemaining ? Math.max(1, Math.floor(otpSecondsRemaining / 60)) : 10} minute(s).
              </p>
              <button
                onClick={handleCancelOTP}
                className="text-amber-500 hover:text-amber-400 text-sm"
                disabled={processing}
              >
                Annuler et modifier mes informations
              </button>

              <label className="block text-sm text-gray-300 mt-4">
                Entrez le code de vérification
              </label>
              <OTPInput
                length={6}
                onComplete={handleOTPComplete}
                loading={processing}
                error={error}
                expiryMinutes={10}
                onExpiry={() => {
                  setError('Code OTP expiré. Veuillez recommencer.');
                  setStep('form');
                  setIntentId(null);
                  setOtpSecondsRemaining(null);
                }}
              />
            </div>
          )}

          {step === 'password' && intentId && (
            <form onSubmit={handlePasswordSubmit} className="space-y-5">
              <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-4 text-sm text-gray-300">
                <p>
                  Votre numéro <span className="text-white font-semibold">{formData.numero_whatsapp}</span> sera votre identifiant de connexion.
                  Choisissez un mot de passe pour sécuriser l’accès à votre espace lecteur.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  <Lock className="inline w-4 h-4 mr-2" /> Mot de passe
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-amber-500"
                  placeholder="Minimum 8 caractères"
                  required
                  minLength={8}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Confirmation du mot de passe
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-amber-500"
                  placeholder="Confirmez votre mot de passe"
                  required
                  minLength={8}
                />
              </div>

              <button
                type="submit"
                disabled={processing}
                className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-black font-bold py-4 rounded-lg hover:from-emerald-600 hover:to-teal-600 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {processing ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" /> Création du compte...
                  </>
                ) : (
                  'Créer mon mot de passe'
                )}
              </button>
            </form>
          )}

          {step === 'payment' && intentId && formule && (
            <div className="space-y-6">
              <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-4 text-sm text-gray-300">
                <p>
                  Connecté en tant que{' '}
                  <span className="text-white font-semibold">
                    {formData.numero_whatsapp}
                  </span>
                  . Vous pouvez à tout moment vous reconnecter avec ce numéro et votre mot de passe.
                </p>
              </div>

              {!paymentSession && (
                <button
                  type="button"
                  onClick={handlePaymentStart}
                  disabled={processing}
                  className="w-full bg-gradient-to-r from-amber-500 to-yellow-600 text-black font-bold py-4 rounded-lg hover:from-amber-600 hover:to-yellow-700 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {processing ? (
                    <>
                      <Loader className="w-5 h-5 animate-spin" /> Préparation du paiement...
                    </>
                  ) : (
                    `Payer ${formule.prix_fcfa?.toLocaleString()} FCFA`
                  )}
                </button>
              )}

              {paymentSession && (
                <div className="space-y-4 text-center">
                  <div className="bg-blue-900/30 border border-blue-700 text-blue-100 px-4 py-3 rounded-lg text-sm">
                    Une fenêtre sécurisée iPay va s’ouvrir. Terminez le paiement puis revenez sur cette page.
                  </div>
                  <button
                    type="button"
                    className="ipaymoney-button px-6 py-3 rounded-lg font-semibold bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    data-amount={String(paymentSession.amount ?? 0)}
                    data-environement={paymentSession.environment}
                    data-key={paymentSession.publicKey}
                    data-transaction-id={paymentSession.transactionId}
                    data-redirect-url={paymentSession.redirectUrl}
                    data-callback-url={paymentSession.callbackUrl}
                    disabled={!ipayScriptLoaded}
                  >
                    {ipayScriptLoaded ? 'Ouvrir la fenêtre de paiement' : 'Chargement du module iPay...'}
                  </button>
                  <p className="text-xs text-gray-500">
                    Référence :{' '}
                    <span className="font-mono text-gray-300">{paymentSession.transactionId}</span>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
