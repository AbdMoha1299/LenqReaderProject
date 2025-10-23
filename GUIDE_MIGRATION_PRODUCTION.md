# 🚀 Guide de Migration vers la Production

## ✅ Ce qui est DÉJÀ fait

- ✅ Toutes les Edge Functions sont déjà déployées
- ✅ Le fichier `.env` pointe vers la bonne base de données
- ✅ Le code frontend est prêt

## 📋 Ce qu'il reste à faire

### Étape 1: Exécuter la migration SQL

1. **Ouvrir l'éditeur SQL de Supabase:**
   ```
   https://supabase.com/dashboard/project/esfpovjwjdajzubxhecu/sql/new
   ```

2. **Copier le contenu du fichier:**
   ```
   MIGRATION_PRODUCTION_SAFE.sql
   ```

3. **Coller dans l'éditeur SQL et cliquer sur "Run"**

   La migration va automatiquement:
   - ✅ Créer les tables manquantes (formules, abonnements, paiements, otp_codes, payment_events)
   - ✅ Ajouter les colonnes manquantes à la table `users`
   - ✅ Créer les 3 formules d'abonnement (Mensuel, Trimestriel, Annuel)
   - ✅ Configurer les politiques RLS (sécurité)
   - ✅ Créer les 4 fonctions RPC (initiate, confirm, cancel, check)
   - ✅ Créer tous les index pour la performance

   **⚠️ IMPORTANT:** La migration est 100% safe - elle ne supprime AUCUNE donnée existante!

### Étape 2: Vérifier que tout fonctionne

Après avoir exécuté la migration, vérifiez dans le dashboard:

1. **Tables créées:**
   - Allez sur: https://supabase.com/dashboard/project/esfpovjwjdajzubxhecu/editor
   - Vous devriez voir 9 tables dans le menu de gauche

2. **Formules créées:**
   - Cliquez sur la table `formules`
   - Vous devriez voir 3 lignes:
     - Mensuel (2000 XOF / 30 jours)
     - Trimestriel (5000 XOF / 90 jours)
     - Annuel (18000 XOF / 365 jours)

3. **Fonctions RPC:**
   - Allez sur: https://supabase.com/dashboard/project/esfpovjwjdajzubxhecu/database/functions
   - Vous devriez voir 5 fonctions:
     - `initiate_subscription_payment`
     - `confirm_payment`
     - `cancel_payment`
     - `check_subscription_status`
     - `is_admin`

### Étape 3: Tester le système

Une fois la migration exécutée, testez:

1. **Créer un abonnement:**
   - Allez sur votre application
   - Essayez de créer un nouveau compte avec numéro WhatsApp
   - Sélectionnez une formule d'abonnement
   - Vérifiez que le paiement est créé

2. **Vérifier dans la base:**
   ```sql
   SELECT * FROM abonnements;
   SELECT * FROM paiements;
   SELECT * FROM payment_events;
   ```

## 🎯 Structure complète du système

### Tables principales:

```
users (table existante améliorée)
├── id
├── nom, email, password_hash, role
├── numero_abonne, numero_whatsapp
├── statut_abonnement, date_fin_abonnement
└── created_at, updated_at

formules (nouvelle table)
├── id, nom, prix, duree_jours
├── actif, description
└── created_at, updated_at

abonnements (nouvelle table)
├── id, user_id → users(id)
├── formule_id → formules(id)
├── statut, date_debut, date_fin
└── created_at, updated_at

paiements (nouvelle table)
├── id, user_id → users(id)
├── formule_id → formules(id)
├── montant, statut, reference
├── ipay_status, ipay_transaction_id
├── country_code, currency, metadata
└── created_at, updated_at

otp_codes (nouvelle table)
├── id, phone_number, code
├── expires_at, verified, attempts
└── created_at

payment_events (nouvelle table - audit trail)
├── id, payment_id → paiements(id)
├── event_type, actor_id, actor_type
├── metadata
└── created_at
```

### Fonctions RPC disponibles:

```sql
-- 1. Initier un paiement d'abonnement
SELECT initiate_subscription_payment(
  p_user_id := 'user-uuid',
  p_formule_id := 'formule-uuid',
  p_country_code := 'SN',
  p_currency := 'XOF'
);

-- 2. Confirmer un paiement (admin ou webhook)
SELECT confirm_payment(
  p_payment_id := 'payment-uuid',
  p_admin_id := 'admin-uuid',  -- NULL pour webhook
  p_ipay_data := '{"transaction_id": "..."}'::jsonb
);

-- 3. Annuler un paiement (admin only)
SELECT cancel_payment(
  p_payment_id := 'payment-uuid',
  p_reason := 'Raison de l\'annulation'
);

-- 4. Vérifier le statut d'un abonnement
SELECT check_subscription_status(
  p_user_id := 'user-uuid'
);
```

## 🔒 Sécurité (RLS)

Toutes les tables ont des politiques RLS strictes:

- ✅ Les utilisateurs ne peuvent voir que LEURS données
- ✅ Les admins peuvent gérer toutes les données
- ✅ Les webhooks peuvent mettre à jour les paiements
- ✅ Aucun accès non autorisé n'est possible

## ⚡ Edge Functions déployées

Les Edge Functions suivantes sont déjà actives:

1. **ipay-webhook** - Reçoit les notifications d'iPay
2. **initiate-payment** - Initie un paiement sécurisé
3. **check-payment-status** - Vérifie le statut d'un paiement
4. **check-pending-payments** - Cron job pour vérifier les paiements en attente
5. **send-otp** - Envoie des codes OTP par WhatsApp
6. **verify-otp** - Vérifie les codes OTP

## 📞 Support

Si vous rencontrez des problèmes:

1. Vérifiez les logs dans Supabase Dashboard
2. Vérifiez que la migration s'est bien exécutée sans erreur
3. Testez les fonctions RPC dans l'éditeur SQL

---

**✅ Une fois la migration exécutée, votre système de paiement sera 100% opérationnel!**
