import { useState, useEffect } from 'react';
import { Newspaper, Calendar, Send, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { PDF, User } from '../lib/supabase';

export function EditionPublisher() {
  const { user } = useAuth();
  const [pdfs, setPdfs] = useState<PDF[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPdf, setSelectedPdf] = useState<PDF | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [activeSubscribers, setActiveSubscribers] = useState<User[]>([]);

  useEffect(() => {
    loadPdfs();
    loadActiveSubscribers();
  }, []);

  const loadPdfs = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('pdfs')
        .select('*')
        .order('date_upload', { ascending: false })
        .limit(30);

      if (error) throw error;
      setPdfs(data || []);
    } catch (error) {
      console.error('Error loading PDFs:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadActiveSubscribers = async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('role', 'lecteur')
        .in('statut_abonnement', ['actif', 'essai']);

      if (error) throw error;

      const activeUsers = (data || []).filter(user => {
        if (!user.date_fin_abonnement) {
          return user.statut_abonnement === 'actif' || user.statut_abonnement === 'essai';
        }
        return new Date(user.date_fin_abonnement) >= new Date();
      });

      setActiveSubscribers(activeUsers);
    } catch (error) {
      console.error('Error loading active subscribers:', error);
    }
  };

  const publishEdition = (pdf: PDF) => {
    setSelectedPdf(pdf);
    setShowPublishModal(true);
  };

  const getStatusColor = (statut?: string) => {
    switch (statut) {
      case 'publie':
        return 'bg-green-900/50 text-green-300 border-green-700';
      case 'planifie':
        return 'bg-blue-900/50 text-blue-300 border-blue-700';
      case 'archive':
        return 'bg-gray-900/50 text-gray-400 border-gray-700';
      default:
        return 'bg-amber-900/50 text-amber-300 border-amber-700';
    }
  };

  const getStatusIcon = (statut?: string) => {
    switch (statut) {
      case 'publie':
        return <CheckCircle className="w-4 h-4" />;
      case 'planifie':
        return <Clock className="w-4 h-4" />;
      default:
        return <AlertCircle className="w-4 h-4" />;
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
        <p className="text-gray-400 mt-4">Chargement des éditions...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white flex items-center gap-2 mb-2">
          <Newspaper className="w-7 h-7 text-amber-500" />
          Publication des Éditions
        </h2>
        <div className="flex items-center gap-4 text-sm text-gray-400">
          <span className="flex items-center gap-1">
            <CheckCircle className="w-4 h-4 text-green-400" />
            {activeSubscribers.length} abonnés actifs
          </span>
          <span>•</span>
          <span>{pdfs.filter(p => p.statut_publication === 'publie').length} éditions publiées</span>
        </div>
      </div>

      <div className="bg-blue-900/20 border border-blue-700 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-200">
            <p className="font-medium mb-1">Publication d'édition</p>
            <p className="text-blue-300">
              Lorsque vous publiez une édition, des liens de lecture personnalisés et sécurisés seront générés pour chaque abonné actif.
              Les messages WhatsApp contenant ces liens seront envoyés automatiquement et instantanément.
            </p>
          </div>
        </div>
      </div>

      {pdfs.length === 0 ? (
        <div className="text-center py-12">
          <Newspaper className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400">Aucune édition disponible</p>
          <p className="text-gray-500 text-sm mt-2">Téléversez d'abord un PDF dans l'onglet Upload</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pdfs.map((pdf) => (
            <div
              key={pdf.id}
              className="bg-gray-700 border border-gray-600 rounded-lg p-4 hover:border-amber-500 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-white font-semibold text-lg">{pdf.titre}</h3>
                    <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${getStatusColor(pdf.statut_publication)}`}>
                      {getStatusIcon(pdf.statut_publication)}
                      {pdf.statut_publication || 'Brouillon'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm text-gray-300 mb-3">
                    {pdf.date_edition && (
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        <span>Édition du {new Date(pdf.date_edition).toLocaleDateString('fr-FR')}</span>
                      </div>
                    )}
                    {pdf.numero_edition && (
                      <div className="flex items-center gap-2">
                        <Newspaper className="w-4 h-4 text-gray-400" />
                        <span>Numéro {pdf.numero_edition}</span>
                      </div>
                    )}
                    {pdf.nb_envois !== undefined && pdf.nb_envois > 0 && (
                      <div className="flex items-center gap-2">
                        <Send className="w-4 h-4 text-gray-400" />
                        <span>{pdf.nb_envois} envoi{pdf.nb_envois > 1 ? 's' : ''}</span>
                      </div>
                    )}
                  </div>

                  {pdf.date_publication_reelle && (
                    <div className="text-xs text-gray-400">
                      Publié le {new Date(pdf.date_publication_reelle).toLocaleString('fr-FR')}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {pdf.statut_publication !== 'publie' && (
                    <button
                      onClick={() => publishEdition(pdf)}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-black font-medium rounded-lg hover:bg-amber-700 transition-colors"
                    >
                      <Send className="w-4 h-4" />
                      Publier
                    </button>
                  )}
                  {pdf.statut_publication === 'publie' && (
                    <button
                      onClick={() => publishEdition(pdf)}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500 transition-colors"
                    >
                      <Send className="w-4 h-4" />
                      Renvoyer
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showPublishModal && selectedPdf && (
        <PublishModal
          pdf={selectedPdf}
          activeSubscribers={activeSubscribers}
          onClose={() => {
            setShowPublishModal(false);
            setSelectedPdf(null);
          }}
          onSuccess={() => {
            setShowPublishModal(false);
            setSelectedPdf(null);
            loadPdfs();
          }}
          userId={user?.id || ''}
        />
      )}
    </div>
  );
}

interface PublishModalProps {
  pdf: PDF;
  activeSubscribers: User[];
  onClose: () => void;
  onSuccess: () => void;
  userId: string;
}

function PublishModal({ pdf, activeSubscribers, onClose, onSuccess }: PublishModalProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generatedLinks, setGeneratedLinks] = useState(0);

  const handlePublish = async () => {
    setLoading(true);
    setProgress(0);
    setGeneratedLinks(0);

    try {
      const totalSubscribers = activeSubscribers.length;

      if (totalSubscribers === 0) {
        alert('Aucun abonné actif à qui envoyer cette édition');
        return;
      }

      const promises = activeSubscribers.map(async (subscriber, index) => {
        const token = crypto.randomUUID();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        const { error: tokenError } = await supabase
          .from('tokens')
          .insert({
            pdf_id: pdf.id,
            user_id: subscriber.id,
            token,
            expires_at: expiresAt.toISOString(),
            used: false,
            max_access_count: 999,
            revoked: false,
          });

        if (tokenError) {
          console.error('Token insertion error:', tokenError);
          throw new Error(`Erreur lors de la création du token: ${tokenError.message}`);
        }

        const link = `${window.location.origin}/read/${token}`;

        const { error: notifError } = await supabase
          .from('notifications')
          .insert({
            user_id: subscriber.id,
            pdf_id: pdf.id,
            type_notification: 'nouvelle_edition',
            numero_destinataire: subscriber.numero_whatsapp || '',
            message: `Bonjour ${subscriber.nom}! La nouvelle édition de L'Enquêteur est disponible. Cliquez sur le lien pour lire: ${link}`,
            lien_lecture: link,
            statut: 'en_attente',
            date_envoi_prevue: new Date().toISOString(),
          });

        if (notifError) {
          console.error('Notification insertion error:', notifError);
          throw new Error(`Erreur lors de la création de la notification: ${notifError.message}`);
        }

        const message = `Bonjour ${subscriber.nom}! La nouvelle édition de L'Enquêteur est disponible. Cliquez sur le lien pour lire: ${link}`;

        try {
          const whatsappResponse = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-whatsapp`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({
                to: subscriber.numero_whatsapp,
                text: message,
              }),
            }
          );

          const whatsappResult = await whatsappResponse.json();

          if (whatsappResult.success) {
            await supabase
              .from('notifications')
              .update({
                statut: 'envoye',
                date_envoi_reelle: new Date().toISOString(),
              })
              .eq('user_id', subscriber.id)
              .eq('pdf_id', pdf.id)
              .eq('lien_lecture', link);
          } else {
            console.error('WhatsApp sending failed:', whatsappResult.error);
            await supabase
              .from('notifications')
              .update({
                statut: 'echec',
                erreur: whatsappResult.error || 'Erreur inconnue',
                tentatives: 1,
              })
              .eq('user_id', subscriber.id)
              .eq('pdf_id', pdf.id)
              .eq('lien_lecture', link);
          }
        } catch (whatsappError) {
          console.error('WhatsApp API error:', whatsappError);
          await supabase
            .from('notifications')
            .update({
              statut: 'echec',
              erreur: whatsappError instanceof Error ? whatsappError.message : 'Erreur réseau',
              tentatives: 1,
            })
            .eq('user_id', subscriber.id)
            .eq('pdf_id', pdf.id)
            .eq('lien_lecture', link);
        }

        setGeneratedLinks(prev => prev + 1);
        setProgress(Math.round(((index + 1) / totalSubscribers) * 100));

        await new Promise(resolve => setTimeout(resolve, 200));
      });

      await Promise.all(promises);

      const { error: updateError } = await supabase
        .from('pdfs')
        .update({
          statut_publication: 'publie',
          date_publication_reelle: new Date().toISOString(),
          nb_envois: (pdf.nb_envois || 0) + totalSubscribers,
        })
        .eq('id', pdf.id);

      if (updateError) throw updateError;

      const { data: notificationStats } = await supabase
        .from('notifications')
        .select('statut')
        .eq('pdf_id', pdf.id);

      const sentCount = notificationStats?.filter(n => n.statut === 'envoye').length || 0;
      const failedCount = notificationStats?.filter(n => n.statut === 'echec').length || 0;

      let message = `Édition publiée avec succès!\n\n`;
      message += `${totalSubscribers} liens générés\n`;
      message += `${sentCount} messages WhatsApp envoyés\n`;
      if (failedCount > 0) {
        message += `${failedCount} échecs d'envoi (vérifiez les logs)`;
      }

      alert(message);
      onSuccess();
    } catch (error) {
      console.error('Error publishing edition:', error);
      const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
      alert(`Erreur lors de la publication:\n${errorMessage}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md w-full">
        <h3 className="text-white font-bold text-xl mb-4">Publier l'édition</h3>

        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-4">
          <p className="text-white font-medium mb-2">{pdf.titre}</p>
          <div className="space-y-1 text-sm text-gray-400">
            <p>Abonnés actifs: {activeSubscribers.length}</p>
            <p>Liens à générer: {activeSubscribers.length}</p>
            <p>Durée de validité: 24 heures</p>
            <p className="text-amber-400">Protection anti-partage activée</p>
          </div>
        </div>

        {loading && (
          <div className="mb-4">
            <div className="flex justify-between text-sm text-gray-400 mb-2">
              <span>Envoi en cours...</span>
              <span>{generatedLinks} / {activeSubscribers.length}</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-amber-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        <div className="bg-amber-900/20 border border-amber-700 rounded-lg p-3 mb-4 text-sm text-amber-200">
          <p className="font-medium mb-1">Important:</p>
          <p>
            Cette action va créer {activeSubscribers.length} liens personnalisés et envoyer {activeSubscribers.length} messages
            WhatsApp automatiquement aux abonnés actifs.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            Annuler
          </button>
          <button
            onClick={handlePublish}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-amber-600 text-black font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-black"></div>
                {progress}%
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Publier
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
