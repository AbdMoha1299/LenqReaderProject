import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Edition } from '../lib/supabase';

export function useEditions() {
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEditions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { data, error: queryError } = await supabase
        .from('editions')
        .select('*')
        .order('created_at', { ascending: false });

      if (queryError) throw queryError;
      setEditions(data || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors du chargement des éditions';
      setError(message);
      console.error('Error loading editions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEditions();
  }, [loadEditions]);

  const createEdition = useCallback(async (params: {
    titre: string;
    numeroEdition?: number;
    dateEdition?: string;
    pdfUrl: string;
    userId: string;
  }) => {
    try {
      const { data, error: insertError } = await supabase
        .from('editions')
        .insert({
          titre: params.titre,
          numero_edition: params.numeroEdition || null,
          date_edition: params.dateEdition || null,
          pdf_url: params.pdfUrl,
          statut: 'draft',
          created_by: params.userId,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      await loadEditions();
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors de la création';
      console.error('Error creating edition:', err);
      return { success: false, error: message };
    }
  }, [loadEditions]);

  const extractArticles = useCallback(async (editionId: string, pdfUrl: string) => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extract-articles`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
          body: JSON.stringify({ editionId, pdfUrl }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de l\'extraction');
      }

      const result = await response.json();
      await loadEditions();
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur lors de l\'extraction';
      console.error('Error extracting articles:', err);
      return { success: false, error: message };
    }
  }, [loadEditions]);

  return {
    editions,
    loading,
    error,
    loadEditions,
    createEdition,
    extractArticles,
  };
}
