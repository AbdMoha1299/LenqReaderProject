import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Vérification de la configuration (sans throw pour ne pas bloquer l'app)
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Configuration Supabase manquante!', {
    url: supabaseUrl ? '✅ Défini' : '❌ Manquant',
    key: supabaseAnonKey ? '✅ Défini' : '❌ Manquant',
    env: import.meta.env,
  });
  console.warn('⚠️ Vérifiez que le fichier .env existe et que le serveur a été redémarré');
} else {
  console.log('✅ Supabase configuré:', {
    url: supabaseUrl,
    keyPrefix: supabaseAnonKey.substring(0, 20) + '...',
  });
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface User {
  id: string;
  nom: string;
  email: string;
  auth_user_id?: string | null;
  role: 'admin' | 'lecteur';
  created_at: string;
  numero_whatsapp?: string | null;
  whatsapp_verifie?: boolean;
  numero_abonne?: string | null;
  statut_abonnement?: 'actif' | 'inactif' | 'suspendu' | 'essai' | 'expire';
  date_fin_abonnement?: string | null;
  score_confiance?: number;
  devices_autorises?: number;
  code_parrainage?: string | null;
  parraine_par?: string | null;
}

export interface PDF {
  id: string;
  titre: string;
  url_fichier: string;
  date_upload: string;
  uploaded_by: string | null;
  date_edition?: string | null;
  numero_edition?: number | null;
  statut_publication?: 'brouillon' | 'planifie' | 'publie' | 'archive';
  date_publication_prevue?: string | null;
  date_publication_reelle?: string | null;
  nb_lectures?: number;
  nb_envois?: number;
  edition_id?: string | null;
}

export interface Token {
  id: string;
  pdf_id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used: boolean;
  created_at: string;
  first_access_at?: string | null;
  last_access_at?: string | null;
  access_count?: number;
  max_access_count?: number;
  device_fingerprint?: string | null;
  ip_addresses?: any[];
  revoked?: boolean;
  revoked_reason?: string | null;
}

export interface Log {
  id: string;
  pdf_id: string;
  user_id: string;
  ip: string | null;
  user_agent: string | null;
  date_access: string;
  device_fingerprint?: string | null;
  session_id?: string | null;
  duree_lecture_secondes?: number | null;
  pages_vues?: any[];
  geo_data?: any;
  suspect?: boolean;
}

export interface Formule {
  id: string;
  nom: string;
  description: string | null;
  duree_jours: number;
  prix_fcfa: number;
  actif: boolean;
  essai_gratuit: boolean;
  priorite: number;
  created_at: string;
  external_payment_url?: string | null;
}

export interface Abonnement {
  id: string;
  user_id: string;
  formule_id: string;
  date_debut: string;
  date_fin: string;
  statut: 'actif' | 'expire' | 'suspendu' | 'annule';
  renouvellement_auto: boolean;
  created_at: string;
  updated_at: string;
  formules?: Formule;
  users?: User;
}

export interface Paiement {
  id: string;
  user_id: string;
  abonnement_id: string | null;
  montant_fcfa: number;
  methode_paiement: string;
  reference_transaction: string | null;
  statut: 'en_attente' | 'confirme' | 'echoue' | 'rembourse';
  notes: string | null;
  date_paiement: string;
  confirme_par: string | null;
  created_at: string;
  ipay_reference?: string | null;
  ipay_status?: string | null;
  ipay_transaction_id?: string | null;
  country_code?: string | null;
  msisdn?: string | null;
  currency?: string | null;
  last_status_check?: string | null;
}

export interface AccesSuspect {
  id: string;
  user_id: string;
  token_id: string | null;
  type_alerte: 'acces_multiple' | 'ip_differente' | 'device_multiple' | 'geo_suspect' | 'vitesse_lecture_anormale';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  data: any;
  action_prise: string | null;
  resolu: boolean;
  created_at: string;
}

export interface SessionLecture {
  id: string;
  user_id: string;
  token_id: string;
  pdf_id: string;
  session_id: string;
  device_fingerprint: string | null;
  ip_address: string | null;
  user_agent: string | null;
  debut_session: string;
  fin_session: string | null;
  derniere_activite: string;
  active: boolean;
  pages_consultees: any[];
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  pdf_id: string | null;
  type_notification: 'nouvelle_edition' | 'rappel_paiement' | 'expiration_proche' | 'suspension' | 'bienvenue' | 'autre';
  numero_destinataire: string;
  message: string;
  lien_lecture: string | null;
  statut: 'en_attente' | 'envoye' | 'echoue' | 'annule';
  date_envoi_prevue: string | null;
  date_envoi_reelle: string | null;
  tentatives: number;
  erreur: string | null;
  created_at: string;
}

export interface Bookmark {
  id: string;
  user_id: string;
  pdf_id: string;
  token_id: string | null;
  page_number: number;
  note: string | null;
  created_at: string;
}

export interface ReadingSession {
  id: string;
  user_id: string;
  pdf_id: string;
  token_id: string;
  page_stats: Record<number, number>;
  total_time_seconds: number;
  pages_read: number[];
  last_page: number;
  completed: boolean;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

export interface ScreenshotAttempt {
  id: string;
  user_id: string;
  pdf_id: string;
  token_id: string;
  detection_type: 'screenshot' | 'print' | 'devtools' | 'copy' | 'rightclick';
  page_number: number;
  device_info: any;
  created_at: string;
}

export interface Edition {
  id: string;
  titre: string;
  numero_edition: number | null;
  date_edition: string | null;
  date_publication: string | null;
  nb_pages: number;
  pdf_url: string | null;
  cover_image_url: string | null;
  statut: 'draft' | 'processing' | 'ready' | 'published' | 'archived';
  vision_api_processed: boolean;
  vision_api_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Page {
  id: string;
  edition_id: string;
  page_number: number;
  image_url: string | null;
  thumbnail_url: string | null;
  vision_api_response: any;
  created_at: string;
}

export interface Article {
  id: string;
  edition_id: string;
  page_id: string;
  titre: string;
  sous_titre?: string | null;
  contenu_texte: string;
  categorie: string | null;
  auteur: string | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  ordre_lecture: number;
  mots_count: number;
  temps_lecture_estime: number;
  confidence_score: number;
  textract_confidence?: number;
  extraction_method?: 'textract' | 'pdfjs' | 'manual';
  layout_metadata?: any;
  valide: boolean;
  ajuste_manuellement: boolean;
  created_at: string;
  updated_at: string;
}

export interface LectureArticle {
  id: string;
  user_id: string;
  article_id: string;
  temps_lecture_secondes: number;
  pourcentage_lu: number;
  complete: boolean;
  bookmarked: boolean;
  session_id: string | null;
  device_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenArticle {
  id: string;
  article_id: string;
  user_id: string;
  token: string;
  expires_at: string;
  access_count: number;
  max_access_count: number;
  revoked: boolean;
  created_at: string;
}
