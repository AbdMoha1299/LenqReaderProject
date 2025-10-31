/**
 * Script de diagnostic pour tester la connexion admin
 *
 * Pour l'utiliser:
 * 1. Ouvrir la console du navigateur (F12)
 * 2. Copier/coller ce script dans la console
 * 3. Remplacer EMAIL et PASSWORD par vos identifiants admin
 * 4. Appuyer sur Entrée
 */

const SUPABASE_URL = 'https://esfpovjwjdajzubxhecu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzZnBvdmp3amRhanp1YnhoZWN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA0MzYxNjYsImV4cCI6MjA3NjAxMjE2Nn0.oP4NWkT_tqO3Zb-fgd6gHW8L-m4Vsw2JgdHxxExQKx0';

// REMPLACER CES VALEURS PAR VOS IDENTIFIANTS
const EMAIL = 'votre-email@example.com';
const PASSWORD = 'votre-mot-de-passe';

async function testAdminLogin() {
  console.log('=== Diagnostic de connexion admin ===\n');

  // Test 1: Vérifier que Supabase est accessible
  console.log('1️⃣ Test de connectivité Supabase...');
  try {
    const healthCheck = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    console.log('✅ Supabase est accessible:', healthCheck.ok);
    console.log('   Status:', healthCheck.status);
  } catch (err) {
    console.error('❌ Erreur de connectivité Supabase:', err);
    return;
  }

  // Test 2: Tester l'authentification
  console.log('\n2️⃣ Test d\'authentification...');
  try {
    const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD
      })
    });

    const authData = await authResponse.json();

    if (!authResponse.ok) {
      console.error('❌ Échec de l\'authentification');
      console.error('   Erreur:', authData.error_description || authData.msg || authData.error);

      if (authData.error === 'invalid_grant') {
        console.error('   ⚠️  Email ou mot de passe incorrect');
      }
      return;
    }

    console.log('✅ Authentification réussie');
    console.log('   User ID:', authData.user?.id);
    console.log('   Email:', authData.user?.email);

    const accessToken = authData.access_token;

    // Test 3: Vérifier l'utilisateur dans la table users
    console.log('\n3️⃣ Test de récupération du profil utilisateur...');

    const userResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(EMAIL)}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const userData = await userResponse.json();

    if (!userResponse.ok) {
      console.error('❌ Échec de récupération du profil');
      console.error('   Erreur:', userData);
      return;
    }

    if (!userData || userData.length === 0) {
      console.error('❌ Aucun utilisateur trouvé dans la table users');
      console.error('   ⚠️  L\'utilisateur existe dans auth.users mais pas dans public.users');
      console.error('   💡 Solution: Créer l\'utilisateur dans la table public.users');
      return;
    }

    const user = userData[0];
    console.log('✅ Profil utilisateur trouvé');
    console.log('   ID:', user.id);
    console.log('   Nom:', user.nom);
    console.log('   Email:', user.email);
    console.log('   Rôle:', user.role);

    // Test 4: Vérifier le rôle admin
    console.log('\n4️⃣ Vérification du rôle admin...');

    if (user.role !== 'admin') {
      console.error('❌ L\'utilisateur n\'a pas le rôle admin');
      console.error('   Rôle actuel:', user.role);
      console.error('   💡 Solution: Mettre à jour le rôle en "admin" dans Supabase');
      return;
    }

    console.log('✅ L\'utilisateur a le rôle admin');

    // Test final
    console.log('\n🎉 Tous les tests ont réussi!');
    console.log('   La connexion devrait fonctionner correctement.');

  } catch (err) {
    console.error('❌ Erreur inattendue:', err);
  }
}

// Vérifier que les identifiants ont été modifiés
if (EMAIL === 'votre-email@example.com' || PASSWORD === 'votre-mot-de-passe') {
  console.error('⚠️  Veuillez modifier EMAIL et PASSWORD dans le script avant de l\'exécuter!');
} else {
  testAdminLogin();
}
