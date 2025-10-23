-- ============================================================================
-- MIGRATION COMPLÈTE POUR LE SYSTÈME DE PAIEMENT ET D'ABONNEMENT
-- À exécuter sur: https://supabase.com/dashboard/project/esfpovjwjdajzubxhecu/sql
-- ============================================================================

-- Extensions nécessaires
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- PARTIE 1: FONCTION HELPER
-- ============================================================================

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

-- ============================================================================
-- PARTIE 2: AMÉLIORATION DE LA TABLE USERS
-- ============================================================================

-- Ajout de colonnes manquantes à users
DO $$
BEGIN
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

-- ============================================================================
-- PARTIE 3: NOUVELLES TABLES
-- ============================================================================

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

-- ============================================================================
-- PARTIE 4: AMÉLIORATION DE LA TABLE PDFS
-- ============================================================================

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

-- ============================================================================
-- PARTIE 5: INDEX
-- ============================================================================

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

-- ============================================================================
-- PARTIE 6: ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS
ALTER TABLE formules ENABLE ROW LEVEL SECURITY;
ALTER TABLE abonnements ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies pour formules
DROP POLICY IF EXISTS "Tout le monde peut voir les formules actives" ON formules;
CREATE POLICY "Tout le monde peut voir les formules actives"
  ON formules FOR SELECT
  USING (actif = true);

DROP POLICY IF EXISTS "Admins peuvent gérer les formules" ON formules;
CREATE POLICY "Admins peuvent gérer les formules"
  ON formules FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- RLS Policies pour abonnements
DROP POLICY IF EXISTS "Users peuvent voir leur propre abonnement" ON abonnements;
CREATE POLICY "Users peuvent voir leur propre abonnement"
  ON abonnements FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR is_admin());

DROP POLICY IF EXISTS "Utilisateurs authentifiés peuvent créer leur abonnement" ON abonnements;
CREATE POLICY "Utilisateurs authentifiés peuvent créer leur abonnement"
  ON abonnements FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Système peut mettre à jour les abonnements" ON abonnements;
CREATE POLICY "Système peut mettre à jour les abonnements"
  ON abonnements FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies pour paiements
DROP POLICY IF EXISTS "Users peuvent voir leurs propres paiements" ON paiements;
CREATE POLICY "Users peuvent voir leurs propres paiements"
  ON paiements FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR is_admin());

DROP POLICY IF EXISTS "Utilisateurs peuvent créer des paiements" ON paiements;
CREATE POLICY "Utilisateurs peuvent créer des paiements"
  ON paiements FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Système et admins peuvent mettre à jour les paiements" ON paiements;
CREATE POLICY "Système et admins peuvent mettre à jour les paiements"
  ON paiements FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies pour OTP
DROP POLICY IF EXISTS "Public peut insérer des OTP" ON otp_codes;
CREATE POLICY "Public peut insérer des OTP"
  ON otp_codes FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "Public peut vérifier des OTP" ON otp_codes;
CREATE POLICY "Public peut vérifier des OTP"
  ON otp_codes FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Public peut mettre à jour des OTP" ON otp_codes;
CREATE POLICY "Public peut mettre à jour des OTP"
  ON otp_codes FOR UPDATE
  USING (true);

-- RLS Policies pour payment_events
DROP POLICY IF EXISTS "Admins peuvent tout voir sur payment_events" ON payment_events;
CREATE POLICY "Admins peuvent tout voir sur payment_events"
  ON payment_events FOR SELECT
  TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS "Utilisateurs voient leurs propres événements" ON payment_events;
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

DROP POLICY IF EXISTS "Système peut insérer des événements" ON payment_events;
CREATE POLICY "Système peut insérer des événements"
  ON payment_events FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================================================
-- PARTIE 7: DONNÉES INITIALES
-- ============================================================================

-- Insérer des formules par défaut si la table est vide
INSERT INTO formules (nom, prix, duree_jours, description)
SELECT * FROM (VALUES
  ('Mensuel', 2000.00, 30, 'Accès illimité pendant 30 jours'),
  ('Trimestriel', 5000.00, 90, 'Accès illimité pendant 90 jours - Économisez 17%'),
  ('Annuel', 18000.00, 365, 'Accès illimité pendant 1 an - Économisez 25%')
) AS v(nom, prix, duree_jours, description)
WHERE NOT EXISTS (SELECT 1 FROM formules LIMIT 1);

-- ============================================================================
-- PARTIE 8: FONCTIONS RPC
-- ============================================================================

-- Fonction: Initier un abonnement avec paiement
CREATE OR REPLACE FUNCTION initiate_subscription_payment(
  p_user_id uuid,
  p_formule_id uuid,
  p_country_code text DEFAULT 'SN',
  p_currency text DEFAULT 'XOF'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_formule record;
  v_abonnement_id uuid;
  v_payment_id uuid;
  v_transaction_ref text;
  v_result jsonb;
BEGIN
  -- Récupérer la formule
  SELECT * INTO v_formule
  FROM formules
  WHERE id = p_formule_id AND actif = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Formule introuvable ou inactive';
  END IF;

  -- Générer une référence unique
  v_transaction_ref := 'ENQU-' || upper(substring(gen_random_uuid()::text, 1, 8)) || '-' || extract(epoch from now())::bigint;

  -- Créer ou mettre à jour l'abonnement (un seul abonnement par user)
  INSERT INTO abonnements (
    user_id,
    formule_id,
    statut,
    date_debut_abonnement,
    date_fin_abonnement
  ) VALUES (
    p_user_id,
    p_formule_id,
    'en_attente',
    NULL,
    NULL
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    formule_id = p_formule_id,
    statut = 'en_attente',
    updated_at = now()
  RETURNING id INTO v_abonnement_id;

  -- Créer le paiement
  INSERT INTO paiements (
    user_id,
    formule_id,
    montant,
    statut,
    ipay_status,
    reference,
    country_code,
    currency,
    metadata
  ) VALUES (
    p_user_id,
    p_formule_id,
    v_formule.prix,
    'en_attente',
    'pending',
    v_transaction_ref,
    p_country_code,
    p_currency,
    jsonb_build_object(
      'formule_nom', v_formule.nom,
      'duree_jours', v_formule.duree_jours
    )
  )
  RETURNING id INTO v_payment_id;

  -- Logger l'événement
  INSERT INTO payment_events (
    payment_id,
    event_type,
    actor_id,
    actor_type,
    metadata
  ) VALUES (
    v_payment_id,
    'created',
    p_user_id,
    'user',
    jsonb_build_object(
      'subscription_id', v_abonnement_id,
      'formule_id', p_formule_id,
      'amount', v_formule.prix,
      'currency', p_currency
    )
  );

  -- Mettre l'utilisateur en statut inactif (en attente de paiement)
  UPDATE users
  SET
    statut_abonnement = 'inactif',
    updated_at = now()
  WHERE id = p_user_id;

  v_result := jsonb_build_object(
    'success', true,
    'subscription_id', v_abonnement_id,
    'payment_id', v_payment_id,
    'transaction_ref', v_transaction_ref,
    'amount', v_formule.prix,
    'currency', p_currency,
    'formule', jsonb_build_object(
      'id', v_formule.id,
      'nom', v_formule.nom,
      'prix', v_formule.prix,
      'duree_jours', v_formule.duree_jours
    )
  );

  RETURN v_result;
END;
$$;

-- Fonction: Confirmer un paiement de manière atomique
CREATE OR REPLACE FUNCTION confirm_payment(
  p_payment_id uuid,
  p_admin_id uuid DEFAULT NULL,
  p_ipay_data jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment record;
  v_abonnement record;
  v_formule record;
  v_new_start_date timestamptz;
  v_new_end_date timestamptz;
  v_result jsonb;
  v_is_admin boolean;
BEGIN
  -- Vérifier les permissions (admin only pour confirmation manuelle)
  v_is_admin := is_admin();
  IF p_admin_id IS NOT NULL AND NOT v_is_admin THEN
    RAISE EXCEPTION 'Accès refusé: fonction réservée aux administrateurs';
  END IF;

  -- Récupérer le paiement avec verrouillage
  SELECT * INTO v_payment
  FROM paiements
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paiement introuvable';
  END IF;

  IF v_payment.statut = 'confirme' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_confirmed', true,
      'payment_id', p_payment_id
    );
  END IF;

  IF v_payment.statut NOT IN ('en_attente', 'pending') THEN
    RAISE EXCEPTION 'Ce paiement ne peut pas être confirmé (statut: %)', v_payment.statut;
  END IF;

  -- Récupérer l'abonnement
  SELECT * INTO v_abonnement
  FROM abonnements
  WHERE user_id = v_payment.user_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Abonnement introuvable pour cet utilisateur';
  END IF;

  -- Récupérer la formule
  SELECT * INTO v_formule
  FROM formules
  WHERE id = COALESCE(v_abonnement.formule_id, v_payment.formule_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Formule introuvable';
  END IF;

  -- Calculer les nouvelles dates (renouvellement intelligent)
  IF v_abonnement.statut = 'actif' AND v_abonnement.date_fin_abonnement IS NOT NULL AND v_abonnement.date_fin_abonnement > now() THEN
    v_new_start_date := v_abonnement.date_debut_abonnement;
    v_new_end_date := v_abonnement.date_fin_abonnement + (v_formule.duree_jours || ' days')::interval;
  ELSE
    v_new_start_date := now();
    v_new_end_date := now() + (v_formule.duree_jours || ' days')::interval;
  END IF;

  -- Transaction atomique: tout ou rien
  UPDATE paiements
  SET
    statut = 'confirme',
    ipay_status = 'succeeded',
    confirmed_by = COALESCE(p_admin_id, auth.uid()),
    confirmed_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_ipay_data, '{}'::jsonb),
    updated_at = now()
  WHERE id = p_payment_id;

  UPDATE abonnements
  SET
    statut = 'actif',
    date_debut_abonnement = v_new_start_date,
    date_fin_abonnement = v_new_end_date,
    updated_at = now()
  WHERE id = v_abonnement.id;

  UPDATE users
  SET
    statut_abonnement = 'actif',
    date_fin_abonnement = v_new_end_date,
    updated_at = now()
  WHERE id = v_payment.user_id;

  INSERT INTO payment_events (
    payment_id,
    event_type,
    actor_id,
    actor_type,
    metadata
  ) VALUES (
    p_payment_id,
    'confirmed',
    COALESCE(p_admin_id, auth.uid()),
    CASE
      WHEN p_admin_id IS NOT NULL THEN 'admin'
      WHEN p_ipay_data IS NOT NULL THEN 'webhook'
      ELSE 'system'
    END,
    jsonb_build_object(
      'subscription_id', v_abonnement.id,
      'new_start_date', v_new_start_date,
      'new_end_date', v_new_end_date,
      'formule_id', v_formule.id,
      'formule_nom', v_formule.nom,
      'ipay_data', p_ipay_data
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'subscription_id', v_abonnement.id,
    'user_id', v_payment.user_id,
    'new_start_date', v_new_start_date,
    'new_end_date', v_new_end_date,
    'formule', jsonb_build_object(
      'id', v_formule.id,
      'nom', v_formule.nom,
      'duree_jours', v_formule.duree_jours
    )
  );

  RETURN v_result;
END;
$$;

-- Fonction: Annuler un paiement
CREATE OR REPLACE FUNCTION cancel_payment(
  p_payment_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment record;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Accès refusé: fonction réservée aux administrateurs';
  END IF;

  SELECT * INTO v_payment
  FROM paiements
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paiement introuvable';
  END IF;

  IF v_payment.statut IN ('confirme', 'annule') THEN
    RAISE EXCEPTION 'Ce paiement ne peut pas être annulé (statut: %)', v_payment.statut;
  END IF;

  UPDATE paiements
  SET
    statut = 'annule',
    ipay_status = 'cancelled',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancel_reason', p_reason),
    updated_at = now()
  WHERE id = p_payment_id;

  INSERT INTO payment_events (
    payment_id,
    event_type,
    actor_id,
    actor_type,
    metadata
  ) VALUES (
    p_payment_id,
    'cancelled',
    auth.uid(),
    'admin',
    jsonb_build_object('reason', p_reason)
  );

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'message', 'Paiement annulé avec succès'
  );
END;
$$;

-- Fonction: Vérifier le statut d'un abonnement
CREATE OR REPLACE FUNCTION check_subscription_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user record;
  v_abonnement record;
  v_formule record;
  v_is_expired boolean;
  v_days_remaining integer;
BEGIN
  IF p_user_id != auth.uid() AND NOT is_admin() THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  SELECT * INTO v_user
  FROM users
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Utilisateur introuvable';
  END IF;

  SELECT * INTO v_abonnement
  FROM abonnements
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_abonnement IS NULL THEN
    RETURN jsonb_build_object(
      'has_subscription', false,
      'status', 'none',
      'message', 'Aucun abonnement trouvé'
    );
  END IF;

  IF v_abonnement.formule_id IS NOT NULL THEN
    SELECT * INTO v_formule
    FROM formules
    WHERE id = v_abonnement.formule_id;
  END IF;

  v_is_expired := v_abonnement.date_fin_abonnement IS NOT NULL AND v_abonnement.date_fin_abonnement < now();
  v_days_remaining := CASE
    WHEN v_abonnement.date_fin_abonnement IS NULL THEN 0
    ELSE GREATEST(0, EXTRACT(DAY FROM v_abonnement.date_fin_abonnement - now())::integer)
  END;

  IF v_is_expired AND v_abonnement.statut = 'actif' THEN
    UPDATE abonnements
    SET statut = 'expire', updated_at = now()
    WHERE id = v_abonnement.id;

    UPDATE users
    SET statut_abonnement = 'expire', updated_at = now()
    WHERE id = p_user_id;

    v_abonnement.statut := 'expire';
  END IF;

  RETURN jsonb_build_object(
    'has_subscription', true,
    'status', v_abonnement.statut,
    'is_active', v_abonnement.statut = 'actif' AND NOT v_is_expired,
    'start_date', v_abonnement.date_debut_abonnement,
    'end_date', v_abonnement.date_fin_abonnement,
    'days_remaining', v_days_remaining,
    'formule', CASE
      WHEN v_formule IS NOT NULL THEN jsonb_build_object(
        'id', v_formule.id,
        'nom', v_formule.nom,
        'prix', v_formule.prix,
        'duree_jours', v_formule.duree_jours
      )
      ELSE NULL
    END
  );
END;
$$;

-- ============================================================================
-- PARTIE 9: PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION initiate_subscription_payment TO authenticated, anon;
GRANT EXECUTE ON FUNCTION confirm_payment TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_payment TO authenticated;
GRANT EXECUTE ON FUNCTION check_subscription_status TO authenticated;

-- ============================================================================
-- FIN DE LA MIGRATION
-- ============================================================================
