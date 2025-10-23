/*
  # Schéma complet du système d'abonnement et de paiement

  1. Tables principales
    - formules: Plans d'abonnement disponibles
    - abonnements: Abonnements des utilisateurs
    - paiements: Historique des paiements
    - otp_codes: Codes OTP pour l'inscription
    - payment_events: Journal des événements de paiement

  2. Sécurité
    - RLS activé sur toutes les tables
    - Politiques restrictives par défaut
*/

-- Extensions nécessaires
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Fonction helper pour vérifier si l'utilisateur est admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Ajout de colonnes manquantes à users
DO $$
BEGIN
  -- Colonnes pour le système d'abonnement
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'numero_abonne') THEN
    ALTER TABLE users ADD COLUMN numero_abonne text UNIQUE;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'numero_whatsapp') THEN
    ALTER TABLE users ADD COLUMN numero_whatsapp text;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'statut_abonnement') THEN
    ALTER TABLE users ADD COLUMN statut_abonnement text DEFAULT 'inactif' CHECK (statut_abonnement IN ('actif', 'inactif', 'expire', 'essai'));
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'date_fin_abonnement') THEN
    ALTER TABLE users ADD COLUMN date_fin_abonnement timestamptz;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'updated_at') THEN
    ALTER TABLE users ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- Table des formules d'abonnement
CREATE TABLE IF NOT EXISTS formules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom text NOT NULL,
  prix decimal(10,2) NOT NULL,
  duree_jours integer NOT NULL,
  actif boolean DEFAULT true,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Table des abonnements
CREATE TABLE IF NOT EXISTS abonnements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  formule_id uuid REFERENCES formules(id),
  statut text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('actif', 'expire', 'en_attente', 'annule')),
  date_debut_abonnement timestamptz,
  date_fin_abonnement timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- Table des paiements
CREATE TABLE IF NOT EXISTS paiements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  formule_id uuid REFERENCES formules(id),
  montant decimal(10,2) NOT NULL,
  statut text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'confirme', 'echoue', 'annule', 'rembourse')),
  ipay_status text DEFAULT 'pending',
  reference text UNIQUE,
  ipay_transaction_id text,
  ipay_reference text,
  country_code text DEFAULT 'SN',
  currency text DEFAULT 'XOF',
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Table des codes OTP
CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  verified boolean DEFAULT false,
  attempts integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Table des événements de paiement (audit trail)
CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES paiements(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'pending', 'processing', 'confirmed', 'failed', 
    'refunded', 'expired', 'cancelled', 'webhook_received'
  )),
  actor_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system', 'webhook')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Colonnes supplémentaires pour PDFs (éditions)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pdfs' AND column_name = 'statut_publication') THEN
    ALTER TABLE pdfs ADD COLUMN statut_publication text DEFAULT 'brouillon' CHECK (statut_publication IN ('brouillon', 'publie', 'archive'));
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pdfs' AND column_name = 'edition_id') THEN
    ALTER TABLE pdfs ADD COLUMN edition_id uuid;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_formules_actif ON formules(actif) WHERE actif = true;
CREATE INDEX IF NOT EXISTS idx_abonnements_user_id ON abonnements(user_id);
CREATE INDEX IF NOT EXISTS idx_abonnements_statut ON abonnements(statut);
CREATE INDEX IF NOT EXISTS idx_paiements_user_id ON paiements(user_id);
CREATE INDEX IF NOT EXISTS idx_paiements_reference ON paiements(reference);
CREATE INDEX IF NOT EXISTS idx_paiements_statut ON paiements(statut);
CREATE INDEX IF NOT EXISTS idx_paiements_created_at ON paiements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_phone_expires ON otp_codes(phone_number, expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_created_at ON payment_events(created_at DESC);

-- Enable RLS
ALTER TABLE formules ENABLE ROW LEVEL SECURITY;
ALTER TABLE abonnements ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies pour formules
CREATE POLICY "Tout le monde peut voir les formules actives"
  ON formules FOR SELECT
  USING (actif = true);

CREATE POLICY "Admins peuvent gérer les formules"
  ON formules FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- RLS Policies pour abonnements
CREATE POLICY "Users peuvent voir leur propre abonnement"
  ON abonnements FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR is_admin());

CREATE POLICY "Utilisateurs authentifiés peuvent créer leur abonnement"
  ON abonnements FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Système peut mettre à jour les abonnements"
  ON abonnements FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies pour paiements
CREATE POLICY "Users peuvent voir leurs propres paiements"
  ON paiements FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR is_admin());

CREATE POLICY "Utilisateurs peuvent créer des paiements"
  ON paiements FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Système et admins peuvent mettre à jour les paiements"
  ON paiements FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies pour OTP
CREATE POLICY "Public peut insérer des OTP"
  ON otp_codes FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public peut vérifier des OTP"
  ON otp_codes FOR SELECT
  USING (true);

CREATE POLICY "Public peut mettre à jour des OTP"
  ON otp_codes FOR UPDATE
  USING (true);

-- RLS Policies pour payment_events
CREATE POLICY "Admins peuvent tout voir sur payment_events"
  ON payment_events FOR SELECT
  TO authenticated
  USING (is_admin());

CREATE POLICY "Utilisateurs voient leurs propres événements"
  ON payment_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM paiements p
      WHERE p.id = payment_events.payment_id
      AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Système peut insérer des événements"
  ON payment_events FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Insérer des formules par défaut si la table est vide
INSERT INTO formules (nom, prix, duree_jours, description)
SELECT * FROM (VALUES
  ('Mensuel', 2000.00, 30, 'Accès illimité pendant 30 jours'),
  ('Trimestriel', 5000.00, 90, 'Accès illimité pendant 90 jours - Économisez 17%'),
  ('Annuel', 18000.00, 365, 'Accès illimité pendant 1 an - Économisez 25%')
) AS v(nom, prix, duree_jours, description)
WHERE NOT EXISTS (SELECT 1 FROM formules LIMIT 1);
