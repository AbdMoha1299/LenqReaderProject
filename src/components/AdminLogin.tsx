import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Shield, Mail, Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

export function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { signIn } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const {
        data: authData,
        error: authError,
      } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !authData.user) {
        throw authError;
      }

      const authUser = authData.user;

      const fetchProfile = async () => {
        const byAuthId = await supabase
          .from('users')
          .select('*')
          .eq('auth_user_id', authUser.id)
          .maybeSingle();

        if (byAuthId.error) throw byAuthId.error;
        if (byAuthId.data) return byAuthId.data;

        const fallback = await supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .maybeSingle();

        if (fallback.error) throw fallback.error;
        return fallback.data;
      };

      const profile = await fetchProfile();

      if (!profile) {
        await supabase.auth.signOut();
        throw new Error("Profil administrateur introuvable. Vérifiez la configuration Supabase.");
      }

      if (profile.role !== 'admin') {
        await supabase.auth.signOut();
        setError('Accès réservé aux administrateurs');
        return;
      }

      signIn(profile);
      navigate('/admin');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Email ou mot de passe incorrect';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <Shield className="w-16 h-16 text-amber-500" />
          </div>
          <h1 className="text-4xl font-bold text-white mb-2">L'Enquêteur</h1>
          <p className="text-gray-400">Administration</p>
        </div>

        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-2xl p-8">
          <h2 className="text-2xl font-bold text-white text-center mb-6">
            Connexion Admin
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                <Mail className="w-4 h-4 inline mr-2" />
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                placeholder="admin@example.com"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                <Lock className="w-4 h-4 inline mr-2" />
                Mot de passe
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                placeholder="••••••••"
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
              {loading ? 'Connexion...' : 'Se connecter'}
            </button>

            <p className="text-center text-gray-400 text-sm mt-4">
              Vous êtes un lecteur ?{' '}
              <Link to="/login" className="text-amber-500 hover:text-amber-400">
                Connexion lecteur
              </Link>
            </p>
          </form>
        </div>

        <div className="text-center mt-6">
          <Link
            to="/"
            className="text-gray-400 hover:text-white text-sm transition-colors"
          >
            ← Retour à l'accueil
          </Link>
        </div>
      </div>
    </div>
  );
}
