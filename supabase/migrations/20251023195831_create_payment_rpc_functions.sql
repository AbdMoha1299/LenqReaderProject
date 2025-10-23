/*
  # Fonctions RPC pour le système de paiement

  1. Fonctions principales
    - initiate_subscription_payment: Initier un paiement d'abonnement
    - confirm_payment: Confirmer un paiement (atomique)
    - cancel_payment: Annuler un paiement
    - check_subscription_status: Vérifier le statut d'un abonnement

  2. Sécurité
    - Toutes les opérations sont atomiques (transactions)
    - Audit trail complet via payment_events
    - Vérifications d'appartenance
*/

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
    NULL,  -- Sera défini lors de la confirmation
    NULL   -- Sera défini lors de la confirmation
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

  -- Construire le résultat
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
    -- Déjà confirmé, retourner le résultat
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

  -- Calculer les nouvelles dates
  -- Si l'abonnement est actif et n'a pas expiré, on prolonge
  -- Sinon, on part d'aujourd'hui
  IF v_abonnement.statut = 'actif' AND v_abonnement.date_fin_abonnement IS NOT NULL AND v_abonnement.date_fin_abonnement > now() THEN
    v_new_start_date := v_abonnement.date_debut_abonnement;
    v_new_end_date := v_abonnement.date_fin_abonnement + (v_formule.duree_jours || ' days')::interval;
  ELSE
    v_new_start_date := now();
    v_new_end_date := now() + (v_formule.duree_jours || ' days')::interval;
  END IF;

  -- Transaction atomique: tout ou rien
  -- 1. Mettre à jour le paiement
  UPDATE paiements
  SET 
    statut = 'confirme',
    ipay_status = 'succeeded',
    confirmed_by = COALESCE(p_admin_id, auth.uid()),
    confirmed_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_ipay_data, '{}'::jsonb),
    updated_at = now()
  WHERE id = p_payment_id;

  -- 2. Mettre à jour l'abonnement
  UPDATE abonnements
  SET 
    statut = 'actif',
    date_debut_abonnement = v_new_start_date,
    date_fin_abonnement = v_new_end_date,
    updated_at = now()
  WHERE id = v_abonnement.id;

  -- 3. Mettre à jour l'utilisateur
  UPDATE users
  SET 
    statut_abonnement = 'actif',
    date_fin_abonnement = v_new_end_date,
    updated_at = now()
  WHERE id = v_payment.user_id;

  -- 4. Logger l'événement
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

  -- Construire le résultat
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
  -- Vérifier les permissions
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Accès refusé: fonction réservée aux administrateurs';
  END IF;

  -- Récupérer le paiement
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

  -- Annuler le paiement
  UPDATE paiements
  SET 
    statut = 'annule',
    ipay_status = 'cancelled',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancel_reason', p_reason),
    updated_at = now()
  WHERE id = p_payment_id;

  -- Logger l'événement
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
  -- Vérifier que l'utilisateur interroge son propre statut ou est admin
  IF p_user_id != auth.uid() AND NOT is_admin() THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  -- Récupérer l'utilisateur
  SELECT * INTO v_user
  FROM users
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Utilisateur introuvable';
  END IF;

  -- Récupérer l'abonnement
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

  -- Récupérer la formule
  IF v_abonnement.formule_id IS NOT NULL THEN
    SELECT * INTO v_formule
    FROM formules
    WHERE id = v_abonnement.formule_id;
  END IF;

  -- Calculer si expiré et jours restants
  v_is_expired := v_abonnement.date_fin_abonnement IS NOT NULL AND v_abonnement.date_fin_abonnement < now();
  v_days_remaining := CASE 
    WHEN v_abonnement.date_fin_abonnement IS NULL THEN 0
    ELSE GREATEST(0, EXTRACT(DAY FROM v_abonnement.date_fin_abonnement - now())::integer)
  END;

  -- Si expiré, mettre à jour le statut
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

-- Accorder les permissions
GRANT EXECUTE ON FUNCTION initiate_subscription_payment TO authenticated, anon;
GRANT EXECUTE ON FUNCTION confirm_payment TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_payment TO authenticated;
GRANT EXECUTE ON FUNCTION check_subscription_status TO authenticated;
