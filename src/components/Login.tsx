import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogIn, Phone, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatPhoneNumber } from '../lib/otp';
import { phoneToAuthEmail } from '../lib/subscriptionFlow';
import { useAuth } from '../contexts/AuthContext';

export function Login() {
  const navigate = useNavigate();
  const { signIn: setAuthUser } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!phone || !password) {
      setError('Veuillez renseigner votre numéro et votre mot de passe.');
      return;
    }

    setLoading(true);
    try {
      const normalized = formatPhoneNumber(phone);
      const identifier = phoneToAuthEmail(normalized);

      const {
        data: authResult,
        error: signInError,
      } = await supabase.auth.signInWithPassword({
        email: identifier,
        password,
      });

      if (signInError || !authResult.user) {
        setError(signInError?.message || 'Connexion impossible. Vérifiez vos identifiants.');
        return;
      }

      const authUser = authResult.user;

      const findProfile = async () => {
        const direct = await supabase
          .from('users')
          .select('*')
          .eq('auth_user_id', authUser.id)
          .maybeSingle();

        if (direct.error) {
          throw direct.error;
        }
        if (direct.data) {
          return direct.data;
        }

        const orFilters: string[] = [];
        if (authUser.email) {
          orFilters.push(`email.eq.${authUser.email}`);
        }

        const metaPhone =
          (authUser.user_metadata?.numero_whatsapp as string | undefined) ??
          (authUser.phone as string | undefined) ??
          normalized;

        if (metaPhone) {
          const trimmed = metaPhone.trim();
          orFilters.push(`numero_whatsapp.eq.${trimmed}`);
          if (trimmed.startsWith('+')) {
            orFilters.push(`numero_whatsapp.eq.${trimmed.substring(1)}`);
          }
        }

        if (orFilters.length === 0) {
          return null;
        }

        const fallback = await supabase
          .from('users')
          .select('*')
          .or(orFilters.join(','))
          .maybeSingle();

        if (fallback.error) {
          throw fallback.error;
        }

        return fallback.data;
      };

      const profile = await findProfile();

      if (!profile) {
        await supabase.auth.signOut();
        setError(
          "Profil utilisateur introuvable. Contactez le support pour finaliser la migration de votre compte."
        );
        return;
      }

      setAuthUser(profile as any);
      navigate('/my-account');
    } catch (err: any) {
      console.error('Erreur connexion:', err);
      setError(err.message || 'Une erreur est survenue lors de la connexion.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">L'Enquêteur</h1>
          <p className="text-gray-400">Liseuse sécurisée</p>
        </div>

        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-2xl p-8">
          <div className="flex items-center justify-center mb-6">
            <div className="bg-gradient-to-r from-amber-500 to-yellow-600 p-3 rounded-full">
              <LogIn className="w-6 h-6 text-black" />
            </div>
          </div>

          <h2 className="text-2xl font-bold text-white text-center mb-6">Connexion à votre compte</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                <Phone className="inline w-4 h-4 mr-2" />
                Numéro de téléphone
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                placeholder="+227 98 76 54 32"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Utilisez le même numéro WhatsApp que lors de votre inscription.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                <Lock className="inline w-4 h-4 mr-2" />
                Mot de passe
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                placeholder="********"
                required
              />
            </div>

            {error && (
              <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-amber-500 to-yellow-600 text-black font-semibold py-3 rounded-lg hover:from-amber-600 hover:to-yellow-700 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Connexion en cours...' : 'Se connecter'}
            </button>
          </form>

          <p className="text-center text-gray-400 text-sm mt-6">
            Pas encore de compte ?{' '}
            <Link to="/subscribe" className="text-amber-500 hover:text-amber-400">
              S'inscrire
            </Link>
          </p>
        </div>

        <div className="text-center mt-6">
          <Link to="/" className="text-gray-400 hover:text-white text-sm transition-colors">
            ← Retour à l'accueil
          </Link>
        </div>
      </div>
    </div>
  );
}

