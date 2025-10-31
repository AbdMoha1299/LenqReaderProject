import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Newspaper,
  LogOut,
  User,
  Calendar,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Gift,
  RefreshCw,
  Book,
  Award,
  Zap,
  BookOpen,
  Loader2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { User as UserType, Abonnement, PDF } from '../lib/supabase';

export function ReaderDashboard() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [userData, setUserData] = useState<UserType | null>(null);
  const [abonnement, setAbonnement] = useState<Abonnement | null>(null);
  const [editions, setEditions] = useState<PDF[]>([]);
  const [loading, setLoading] = useState(true);
  const [readingEdition, setReadingEdition] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadUserData();
      loadAbonnement();
      loadEditions();
    }
  }, [user]);

  const loadUserData = async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', user?.id)
        .maybeSingle();

      if (error) throw error;
      setUserData(data);
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  };

  const handleReadEdition = async (edition: PDF) => {
    if (!user) {
      alert("Vous devez être connecté pour accéder à l'édition.");
      return;
    }

    setReadingEdition(edition.id);
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        throw new Error(sessionError.message);
      }
      if (!session?.access_token) {
        throw new Error("Session expirée. Veuillez vous reconnecter.");
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-reading-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            pdfId: edition.id,
            reuseExisting: true,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Impossible de générer un accès sécurisé pour cette édition.");
      }

      navigate(`/read/${data.token}`);
    } catch (error: any) {
      console.error('Erreur génération lien de lecture:', error);
      alert(error.message || "Erreur lors de la génération de l'accès. Veuillez réessayer.");
    } finally {
      setReadingEdition(null);
    }
  };

  const loadAbonnement = async () => {
    try {
      const { data, error } = await supabase
        .from('abonnements')
        .select(`
          *,
          formules (*)
        `)
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setAbonnement(data);
    } catch (error) {
      console.error('Error loading abonnement:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadEditions = async () => {
    try {
      const { data, error } = await supabase
        .from('pdfs')
        .select('*')
        .eq('statut_publication', 'publie')
        .order('date_publication_reelle', { ascending: false })
        .limit(10);

      if (error) throw error;
      setEditions(data || []);
    } catch (error) {
      console.error('Error loading editions:', error);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  const getStatusIcon = (statut?: string) => {
    switch (statut) {
      case 'actif':
        return <CheckCircle className="w-5 h-5" />;
      case 'essai':
        return <Gift className="w-5 h-5" />;
      case 'expire':
        return <XCircle className="w-5 h-5" />;
      case 'suspendu':
        return <AlertTriangle className="w-5 h-5" />;
      case 'inactif':
        return <Clock className="w-5 h-5" />;
      default:
        return <Clock className="w-5 h-5" />;
    }
  };

  const getStatusLabel = (statut?: string) => {
    switch (statut) {
      case 'actif':
        return 'Actif';
      case 'essai':
        return 'Période d\'essai';
      case 'expire':
        return 'Expiré';
      case 'suspendu':
        return 'Suspendu';
      case 'inactif':
        return 'En attente de validation';
      default:
        return 'Inconnu';
    }
  };

  const formatDate = (date: string | null | undefined) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  const getDaysRemaining = (dateFin: string | null | undefined) => {
    if (!dateFin) return null;
    const today = new Date();
    const end = new Date(dateFin);
    const diff = Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-16 w-16 border-4 border-amber-500/20 border-t-amber-500 mb-6"></div>
          <p className="text-gray-300 text-lg font-medium">Chargement...</p>
        </div>
      </div>
    );
  }

  const daysRemaining = getDaysRemaining(userData?.date_fin_abonnement);
  const isActive = userData?.statut_abonnement === 'actif' || userData?.statut_abonnement === 'essai';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-lg shadow-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-2.5 bg-gradient-to-br from-amber-500 to-orange-500 rounded-xl shadow-lg">
              <Newspaper className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">L'Enquêteur</h1>
              <p className="text-xs text-gray-400 font-medium">Mon Espace Lecteur</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-gray-300 hover:text-white transition-all duration-200 rounded-xl hover:scale-105"
          >
            <LogOut className="w-5 h-5" />
            <span className="text-sm font-medium hidden sm:inline">Déconnexion</span>
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-10">
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-3 bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
            Bonjour, {userData?.nom}
          </h2>
          <p className="text-gray-400 text-lg">Bienvenue dans votre espace personnel</p>
        </div>

        <div className="grid gap-6 mb-10">
          <div className="bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
            <div className="flex flex-col sm:flex-row items-start justify-between mb-6 gap-4">
              <div>
                <h3 className="text-2xl sm:text-3xl font-bold text-white mb-2 flex items-center gap-3">
                  <Award className="w-8 h-8 text-amber-500" />
                  Mon Abonnement
                </h3>
                <p className="text-gray-300 font-medium">
                  Formule: <span className="text-amber-400">{abonnement?.formules?.nom || 'Aucune'}</span>
                </p>
              </div>
              <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl font-semibold text-sm shadow-lg ${
                userData?.statut_abonnement === 'actif' ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white' :
                userData?.statut_abonnement === 'essai' ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white' :
                'bg-slate-800 text-gray-300'
              }`}>
                {getStatusIcon(userData?.statut_abonnement)}
                <span>
                  {getStatusLabel(userData?.statut_abonnement)}
                </span>
              </div>
            </div>

            {userData?.statut_abonnement === 'inactif' && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <Clock className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-yellow-300 font-medium mb-1">
                      En attente de validation
                    </p>
                    <p className="text-gray-300 text-sm">
                      Votre paiement est en cours de validation par notre équipe.
                      Vous recevrez une notification WhatsApp dès que votre accès sera activé.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {isActive && daysRemaining !== null && (
              <div className="grid sm:grid-cols-2 gap-4 mb-6">
                <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50 hover:border-slate-600 transition-colors">
                  <p className="text-gray-400 text-sm mb-2 font-medium flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    Date de fin
                  </p>
                  <p className="text-white font-bold text-lg">
                    {formatDate(userData?.date_fin_abonnement)}
                  </p>
                </div>
                <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50 hover:border-slate-600 transition-colors">
                  <p className="text-gray-400 text-sm mb-2 font-medium flex items-center gap-2">
                    <Zap className="w-4 h-4" />
                    Jours restants
                  </p>
                  <p className={`font-bold text-lg ${
                    daysRemaining < 7 ? 'text-red-400' : 'text-green-400'
                  }`}>
                    {daysRemaining > 0 ? `${daysRemaining} jours` : 'Expiré'}
                  </p>
                </div>
              </div>
            )}

            {daysRemaining !== null && daysRemaining < 7 && daysRemaining > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 mb-4">
                <p className="text-amber-300 text-sm">
                  <AlertTriangle className="w-4 h-4 inline mr-2" />
                  Votre abonnement expire dans {daysRemaining} jour{daysRemaining > 1 ? 's' : ''}.
                  Pensez à le renouveler !
                </p>
              </div>
            )}

            {(userData?.statut_abonnement === 'expire' || (daysRemaining !== null && daysRemaining <= 0)) && (
              <button className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-600 transition-colors">
                <RefreshCw className="w-5 h-5" />
                Renouveler mon abonnement
              </button>
            )}
          </div>

          <div className="bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
            <h3 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-amber-500 to-orange-500 rounded-xl">
                <User className="w-6 h-6 text-white" />
              </div>
              Mes Informations
            </h3>
            <div className="space-y-4">
              <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50">
                <p className="text-gray-400 text-sm mb-2 font-medium">Numéro d'abonné</p>
                <p className="text-white font-mono text-base font-bold">{userData?.numero_abonne || 'N/A'}</p>
              </div>
              <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50">
                <p className="text-gray-400 text-sm mb-2 font-medium">Email</p>
                <p className="text-white text-base">{userData?.email}</p>
              </div>
              <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50">
                <p className="text-gray-400 text-sm mb-2 font-medium">WhatsApp</p>
                <p className="text-white text-base">{userData?.numero_whatsapp || 'Non renseigné'}</p>
              </div>
              <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-xl p-4 border border-amber-500/30">
                <p className="text-gray-400 text-sm mb-2 font-medium">Code de parrainage</p>
                <p className="text-amber-400 font-mono text-lg font-bold">
                  {userData?.code_parrainage || 'N/A'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
          <h3 className="text-2xl sm:text-3xl font-bold text-white mb-8 flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-500 to-orange-500 rounded-xl shadow-lg">
              <Book className="w-7 h-7 text-white" />
            </div>
            Dernières Éditions
          </h3>

          {!isActive ? (
            <div className="text-center py-16">
              <div className="inline-flex p-6 bg-yellow-500/10 rounded-2xl mb-6">
                <AlertTriangle className="w-16 h-16 text-yellow-500" />
              </div>
              <p className="text-gray-200 mb-3 text-xl font-bold">Accès aux éditions non disponible</p>
              <p className="text-gray-400 text-lg">
                Votre abonnement doit être actif pour accéder aux éditions
              </p>
            </div>
          ) : editions.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex p-6 bg-slate-800 rounded-2xl mb-6">
                <Calendar className="w-16 h-16 text-gray-500" />
              </div>
              <p className="text-gray-300 text-xl">Aucune édition disponible pour le moment</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {editions.map((edition) => (
                <div
                  key={edition.id}
                  className="group bg-slate-800/50 border border-slate-700 rounded-2xl p-6 hover:border-amber-500/50 transition-all duration-300 hover:shadow-2xl hover:shadow-amber-500/10 hover:-translate-y-1 cursor-pointer"
                >
                  <div className="mb-4">
                    <div className="w-full aspect-[3/4] bg-gradient-to-br from-slate-700 to-slate-800 rounded-xl mb-4 flex items-center justify-center border border-slate-600 group-hover:border-amber-500/50 transition-colors">
                      <BookOpen className="w-16 h-16 text-slate-600 group-hover:text-amber-500 transition-colors" />
                    </div>
                    <h4 className="text-white font-bold text-lg mb-3 line-clamp-2 group-hover:text-amber-400 transition-colors">{edition.titre}</h4>
                    <div className="flex items-center gap-2 text-gray-400 text-sm mb-4">
                      <Calendar className="w-4 h-4" />
                      <span>{formatDate(edition.date_publication_reelle)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleReadEdition(edition)}
                    disabled={readingEdition === edition.id}
                    className="w-full px-4 py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded-xl transition-all duration-200 hover:scale-105 shadow-lg shadow-amber-500/20 disabled:opacity-60 disabled:hover:scale-100 disabled:cursor-not-allowed"
                  >
                    {readingEdition === edition.id ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Chargement...
                      </span>
                    ) : (
                      "Lire l'édition"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
