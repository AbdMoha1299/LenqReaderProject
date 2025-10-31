import { ReaderManifest } from '../types';

interface FetchManifestParams {
  token: string;
  editionId: string;
}

export const manifestService = {
  async fetchManifest({ token, editionId }: FetchManifestParams): Promise<ReaderManifest> {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !anonKey) {
      throw new Error('Supabase environment variables are missing');
    }

    const endpoint = `${supabaseUrl}/functions/v1/reader-manifest`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ token, editionId }),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => 'Unexpected error');
      throw new Error(message || 'Unable to load manifest');
    }

    const payload = (await response.json()) as ReaderManifest;
    return payload;
  },
};

export const preloadImage = (url: string | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (!url) {
      resolve();
      return;
    }

    const img = new Image();
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
