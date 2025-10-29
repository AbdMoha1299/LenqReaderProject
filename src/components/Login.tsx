import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogIn, Phone, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatPhoneNumber } from '../lib/otp';
import { phoneToAuthEmail } from '../lib/subscriptionFlow';

export function Login() {
  const navigate = useNavigate();
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

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: identifier,
        password,
      });

      if (signInError) {
        setError(signInError.message || 'Connexion impossible. Vérifiez vos identifiants.');
        return;
      }

      navigate('/reader');
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
