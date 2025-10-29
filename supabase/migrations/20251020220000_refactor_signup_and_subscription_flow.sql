/*
  # Refactor signup flow and subscription state management

  This migration introduces signup intents to orchestrate the onboarding flow,
  links application users with Supabase Auth, and centralises subscription
  status computation.
*/

-- ------------------------------------------------------------
-- ENUMS & TABLES
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'signup_intent_state'
  ) THEN
    CREATE TYPE signup_intent_state AS ENUM (
      'collect_contact',
      'otp_verified',
      'awaiting_payment',
      'active',
      'expired',
      'cancelled'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.signup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_whatsapp text NOT NULL,
  numero_whatsapp_normalized text NOT NULL,
  country_code text,
  nom text NOT NULL,
  email text,
  formule_id uuid REFERENCES public.formules(id),
  state signup_intent_state NOT NULL DEFAULT 'collect_contact',
  otp_attempts integer NOT NULL DEFAULT 0,
  payment_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_intents_phone_open
  ON public.signup_intents (numero_whatsapp_normalized)
  WHERE state IN ('collect_contact', 'otp_verified', 'awaiting_payment');

CREATE INDEX IF NOT EXISTS idx_signup_intents_state
  ON public.signup_intents(state);

CREATE INDEX IF NOT EXISTS idx_signup_intents_created_at
  ON public.signup_intents(created_at DESC);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.signup_intents_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_signup_intents_updated_at ON public.signup_intents;
CREATE TRIGGER trg_signup_intents_updated_at
  BEFORE UPDATE ON public.signup_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.signup_intents_set_updated_at();

-- RLS
ALTER TABLE public.signup_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signup_intents service access" ON public.signup_intents;
CREATE POLICY "signup_intents service access"
  ON public.signup_intents
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "signup_intents admin read" ON public.signup_intents;
CREATE POLICY "signup_intents admin read"
  ON public.signup_intents
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role = 'admin'
    )
  );

-- ------------------------------------------------------------
-- USERS TABLE ADJUSTMENTS
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE public.users
      ADD COLUMN auth_user_id uuid UNIQUE;

    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_users_auth_user_id
  ON public.users(auth_user_id);

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_statut_abonnement_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_statut_abonnement_check
  CHECK (
    statut_abonnement IN (
      'actif',
      'inactif',
      'suspendu',
      'essai',
      'expire',
      'en_attente'
    )
  );

-- ------------------------------------------------------------
-- ABONNEMENTS TABLE ADJUSTMENTS
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'abonnements'
      AND column_name = 'intent_id'
  ) THEN
    ALTER TABLE public.abonnements
      ADD COLUMN intent_id uuid;

    ALTER TABLE public.abonnements
      ADD CONSTRAINT abonnements_intent_id_fkey
      FOREIGN KEY (intent_id) REFERENCES public.signup_intents(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_abonnements_intent_id
  ON public.abonnements(intent_id);

ALTER TABLE public.abonnements
  ALTER COLUMN statut SET DEFAULT 'en_attente';

-- ------------------------------------------------------------
-- SUBSCRIPTION STATUS MANAGEMENT
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_user_subscription_status(p_user_id uuid)
RETURNS void AS $$
DECLARE
  v_status text;
  v_date_fin timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  v_status := 'inactif';
  v_date_fin := NULL;

  SELECT a.statut,
         a.date_fin
  INTO v_status, v_date_fin
  FROM public.abonnements a
  WHERE a.user_id = p_user_id
  ORDER BY
    CASE
      WHEN a.statut IN ('actif', 'essai') THEN 0
      WHEN a.statut = 'en_attente' THEN 1
      WHEN a.statut = 'suspendu' THEN 2
      WHEN a.statut = 'expire' THEN 3
      ELSE 4
    END,
    a.date_fin DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    v_status := 'inactif';
    v_date_fin := NULL;
  ELSE
    IF v_status IN ('actif', 'essai') THEN
      IF v_date_fin IS NOT NULL AND v_date_fin < now() THEN
        v_status := 'expire';
      END IF;
    END IF;
  END IF;

  UPDATE public.users
    SET statut_abonnement = v_status,
        date_fin_abonnement = v_date_fin
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.abonnements_refresh_user_status_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  PERFORM public.refresh_user_subscription_status(v_user_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_refresh_user_subscription_status ON public.abonnements;
CREATE TRIGGER trigger_refresh_user_subscription_status
  AFTER INSERT OR UPDATE OR DELETE ON public.abonnements
  FOR EACH ROW
  EXECUTE FUNCTION public.abonnements_refresh_user_status_trigger();

-- Backfill statuses
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN SELECT DISTINCT user_id FROM public.abonnements LOOP
    PERFORM public.refresh_user_subscription_status(rec.user_id);
  END LOOP;

  UPDATE public.users u
  SET statut_abonnement = 'inactif',
      date_fin_abonnement = NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM public.abonnements a WHERE a.user_id = u.id
  )
    AND u.statut_abonnement IS DISTINCT FROM 'inactif';
END
$$;

-- ------------------------------------------------------------
-- PERMISSION CHECK FUNCTION
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_has_access_to_edition(
  p_user_id uuid,
  p_pdf_id uuid
)
RETURNS BOOLEAN AS $$
DECLARE
  v_role text;
  v_status text;
  v_date_fin timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT role, statut_abonnement, date_fin_abonnement
  INTO v_role, v_status, v_date_fin
  FROM public.users
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_role = 'admin' THEN
    RETURN TRUE;
  END IF;

  IF v_status IN ('actif', 'essai') THEN
    IF v_date_fin IS NULL OR v_date_fin >= now() THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- PAYMENTS LINKED TO SIGNUP INTENTS
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'paiements'
      AND column_name = 'intent_id'
  ) THEN
    ALTER TABLE public.paiements
      ADD COLUMN intent_id uuid;

    ALTER TABLE public.paiements
      ADD CONSTRAINT paiements_intent_id_fkey
      FOREIGN KEY (intent_id) REFERENCES public.signup_intents(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_paiements_intent_id
  ON public.paiements(intent_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_events'
      AND column_name = 'intent_id'
  ) THEN
    ALTER TABLE public.payment_events
      ADD COLUMN intent_id uuid;

    ALTER TABLE public.payment_events
      ADD CONSTRAINT payment_events_intent_id_fkey
      FOREIGN KEY (intent_id) REFERENCES public.signup_intents(id)
      ON DELETE SET NULL;
  END IF;
END
$$;
