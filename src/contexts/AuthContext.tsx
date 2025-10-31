import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { User } from '../lib/supabase';

type SessionUser = NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>['user'];

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (user: User) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const buildFilters = (sessionUser: SessionUser) => {
      const filters: string[] = [`auth_user_id.eq.${sessionUser.id}`];
      if (sessionUser.email) {
        filters.unshift(`email.eq.${sessionUser.email}`);
      }

      const metaPhone =
        (sessionUser.user_metadata?.numero_whatsapp as string | undefined) ??
        (sessionUser.phone as string | undefined);
      if (metaPhone) {
        const trimmed = metaPhone.trim();
        filters.push(`numero_whatsapp.eq.${trimmed}`);
        if (trimmed.startsWith('+')) {
          filters.push(`numero_whatsapp.eq.${trimmed.substring(1)}`);
        }
      }

      return filters;
    };

    const loadInitialSession = async () => {
      console.log('[AuthContext] Chargement de la session initiale...');

      try {
        // Timeout de 10 secondes pour éviter le blocage infini
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Session timeout')), 10000)
        );

        const sessionPromise = supabase.auth.getSession();

        const { data: { session } } = await Promise.race([
          sessionPromise,
          timeoutPromise
        ]) as Awaited<ReturnType<typeof supabase.auth.getSession>>;

        console.log('[AuthContext] Session récupérée:', session ? 'Connecté' : 'Non connecté');

        if (!session?.user) {
          if (isMounted) {
            setLoading(false);
          }
          return;
        }

        const filters = buildFilters(session.user);
        try {
          const { data } = await supabase
            .from('users')
            .select('*')
            .or(filters.join(','))
            .maybeSingle();

          if (isMounted && data) {
            console.log('[AuthContext] Profil utilisateur chargé:', data.email);
            setUser(data as User);
          }
        } catch (error) {
          console.error('[AuthContext] Erreur chargement profil:', error);
        }
      } catch (error) {
        console.error('[AuthContext] Erreur chargement session:', error);
        if (error instanceof Error && error.message === 'Session timeout') {
          console.error('[AuthContext] ⚠️ Timeout de la session - Vérifiez la configuration Supabase');
        }
      } finally {
        if (isMounted) {
          console.log('[AuthContext] Chargement terminé, setLoading(false)');
          setLoading(false);
        }
      }
    };

    loadInitialSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;

      if (!session?.user) {
        setUser(null);
        return;
      }

      const filters = buildFilters(session.user);
      try {
        const { data } = await supabase
          .from('users')
          .select('*')
          .or(filters.join(','))
          .maybeSingle();

        if (data) {
          setUser(data as User);
        }
      } catch (error) {
        console.error('Failed to refresh user profile', error);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = (userData: User) => {
    setUser(userData);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
