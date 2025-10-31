# 🔧 Guide de débogage - Connexion Admin

## ✅ Diagnostic effectué

Le script de test a confirmé que:
- ✅ La connexion Supabase fonctionne
- ✅ L'authentification avec `admin@lenqueteur.com` réussit
- ✅ L'utilisateur existe dans la table `users` avec le rôle `admin`

**Conclusion:** Le problème vient du code React, pas de Supabase.

---

## 🔍 Modifications apportées

### 1. **AdminLogin.tsx** - Ajout de logs détaillés

Le composant de connexion a été modifié pour afficher des logs détaillés dans la console:

```typescript
// Maintenant chaque étape du processus est loggée:
[AdminLogin] Début de la connexion...
[AdminLogin] Appel de signInWithPassword...
[AdminLogin] Réponse auth: { ... }
[AdminLogin] Auth réussie, récupération du profil...
[AdminLogin] Profil récupéré: { ... }
[AdminLogin] Connexion réussie, navigation vers /admin
[AdminLogin] Fin du processus, setLoading(false)
```

### 2. **supabase.ts** - Vérification de la configuration

Le fichier de configuration Supabase vérifie maintenant que les variables d'environnement sont chargées:

```typescript
// Au chargement de l'app, vous devriez voir:
✅ Supabase configuré: { url: '...', keyPrefix: '...' }
```

---

## 🧪 Comment tester maintenant

### Étape 1: Redémarrer le serveur de développement

```bash
cd "C:\Users\admin\Downloads\project-bolt-sb1-dq6xa4l9\project"
npm run dev
```

### Étape 2: Ouvrir la console du navigateur

1. Ouvrez votre navigateur
2. Allez sur `http://localhost:5173/admin-login`
3. Appuyez sur **F12** pour ouvrir la console
4. Passez à l'onglet **Console**

### Étape 3: Vérifier les logs au chargement

Dès que la page se charge, vous devriez voir:

```
✅ Supabase configuré: {
  url: "https://esfpovjwjdajzubxhecu.supabase.co",
  keyPrefix: "eyJhbGciOiJIUzI1NiIsIn..."
}
```

**Si vous ne voyez PAS ce message:**
- ❌ Les variables d'environnement ne sont pas chargées
- 💡 Solution: Vérifiez que le fichier `.env` est à la racine du projet
- 💡 Redémarrez complètement le serveur (`Ctrl+C` puis `npm run dev`)

### Étape 4: Tester la connexion

Entrez vos identifiants:
- Email: `admin@lenqueteur.com`
- Mot de passe: `password`

Cliquez sur "Se connecter" et observez les logs dans la console.

---

## 📊 Scénarios possibles

### Scénario A: Logs détaillés apparaissent

Si vous voyez tous les logs `[AdminLogin]`, cela signifie que le code s'exécute correctement.

**Logs attendus en cas de succès:**
```
[AdminLogin] Début de la connexion... { email: 'admin@lenqueteur.com' }
[AdminLogin] Appel de signInWithPassword...
[AdminLogin] Réponse auth: { authData: {...}, authError: null }
[AdminLogin] Auth réussie, récupération du profil...
[AdminLogin] Profil récupéré: { userData: {...}, userError: null }
[AdminLogin] Connexion réussie, navigation vers /admin
[AdminLogin] Fin du processus, setLoading(false)
```

**Action:** Vous devriez être redirigé vers `/admin`

### Scénario B: Aucun log n'apparaît

Si vous ne voyez **aucun** log `[AdminLogin]`:
- Le formulaire ne soumet pas
- Problème avec le gestionnaire d'événements
- JavaScript désactivé ou erreur de compilation

**Actions:**
1. Vérifiez l'onglet **Console** pour des erreurs TypeScript/React
2. Vérifiez l'onglet **Network** pour voir si des requêtes sont envoyées
3. Essayez de rafraîchir la page avec `Ctrl+Shift+R` (cache bypass)

### Scénario C: Logs s'arrêtent à une étape

Si les logs s'arrêtent à une étape précise (ex: `[AdminLogin] Appel de signInWithPassword...` sans suite):
- Une promesse ne se résout jamais (timeout)
- Problème réseau
- CORS ou politique de sécurité

**Actions:**
1. Vérifiez l'onglet **Network** dans DevTools
2. Regardez si les requêtes vers `esfpovjwjdajzubxhecu.supabase.co` sont:
   - ⏳ En attente (pending)
   - ❌ Échouées (failed)
   - ✅ Réussies (200 OK)
3. Vérifiez votre connexion internet
4. Désactivez temporairement les extensions de navigateur (bloqueurs de pub, etc.)

### Scénario D: Erreur affichée

Si un message d'erreur s'affiche:
- Lisez le message dans l'interface
- Vérifiez le log `[AdminLogin] Message d'erreur affiché: ...`
- Cherchez le log `[AdminLogin] Erreur lors de la connexion:` pour plus de détails

---

## 🛠️ Solutions aux problèmes courants

### Problème 1: Variables d'environnement non chargées

**Symptôme:**
```
❌ Configuration Supabase manquante!
```

**Solution:**
1. Vérifiez que `.env` existe à la racine du projet
2. Vérifiez que les variables commencent par `VITE_`
3. Redémarrez le serveur de développement complètement

```bash
# Arrêter le serveur (Ctrl+C)
npm run dev
```

### Problème 2: "Utilisateur introuvable"

**Symptôme:**
```
[AdminLogin] Aucun utilisateur trouvé dans la table users
```

**Solution:**
L'utilisateur existe dans `auth.users` mais pas dans `public.users`. Exécutez dans Supabase SQL Editor:

```sql
INSERT INTO public.users (id, nom, email, role, auth_user_id)
VALUES (
  '1a2d0445-1b78-4494-b3fe-fededfa9f24e',
  'Administrateur',
  'admin@lenqueteur.com',
  'admin',
  '1a2d0445-1b78-4494-b3fe-fededfa9f24e'
);
```

### Problème 3: "Accès réservé aux administrateurs"

**Symptôme:**
```
[AdminLogin] Utilisateur sans rôle admin: lecteur
```

**Solution:**
L'utilisateur existe mais n'a pas le bon rôle:

```sql
UPDATE public.users
SET role = 'admin'
WHERE email = 'admin@lenqueteur.com';
```

### Problème 4: Le bouton continue de tourner

**Symptôme:**
- Le bouton affiche "Connexion..." indéfiniment
- Aucun message d'erreur
- Les logs s'arrêtent à une étape

**Solution:**
1. Ouvrez l'onglet **Network** dans DevTools
2. Essayez de vous connecter à nouveau
3. Cherchez les requêtes vers `supabase.co`
4. Cliquez sur chaque requête pour voir:
   - **Status:** 200 OK, 400 Bad Request, timeout, etc.
   - **Response:** Le contenu de la réponse
   - **Timing:** Combien de temps la requête a pris

Si une requête est en **pending** (attente) pendant plus de 30 secondes:
- Problème de réseau ou de timeout
- Vérifiez votre pare-feu ou antivirus
- Essayez sur un autre réseau (4G mobile par exemple)

---

## 📞 Besoin d'aide supplémentaire?

Si le problème persiste après ces étapes:

1. **Prenez une capture d'écran** de la console avec les logs
2. **Notez** à quelle étape les logs s'arrêtent
3. **Copiez** tous les messages d'erreur
4. **Vérifiez** l'onglet Network pour voir les requêtes HTTP

Avec ces informations, nous pourrons identifier précisément le problème!

---

## 🎯 Checklist de vérification

- [ ] Le serveur de développement est démarré (`npm run dev`)
- [ ] Le fichier `.env` existe et contient les bonnes valeurs
- [ ] La console affiche "✅ Supabase configuré"
- [ ] Les logs `[AdminLogin]` apparaissent lors de la connexion
- [ ] L'onglet Network ne montre pas d'erreurs 404 ou 500
- [ ] Aucune extension de navigateur ne bloque les requêtes
- [ ] L'utilisateur existe dans `public.users` avec `role = 'admin'`
