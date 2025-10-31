import { createClient } from '@supabase/supabase-js';

interface RequestPayload {
  token?: string;
  editionId?: string;
}

interface SupabaseTokenRecord {
  id: string;
  user_id: string;
  pdf_id: string;
  expires_at: string;
  revoked: boolean;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const defaultBucket = Deno.env.get('READER_STORAGE_BUCKET') ?? 'editions';

const clamp01 = (value: number | null) => {
  if (value === null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const normalizeLength = (value: number | null) => clamp01(value);

const resolveStorageAsset = async (value?: string | null) => {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  let bucket = defaultBucket;
  let objectPath = value.replace(/^\/+/, '');

  const defaultPrefix = `${defaultBucket}/`;
  if (objectPath.startsWith(defaultPrefix)) {
    objectPath = objectPath.slice(defaultPrefix.length);
  } else if (objectPath.split('/').length > 1 && objectPath.split('/')[0] !== '') {
    const [maybeBucket, ...rest] = objectPath.split('/');
    bucket = maybeBucket;
    objectPath = rest.join('/');
  }

  const { data, error } = await supabase
    .storage
    .from(bucket)
    .createSignedUrl(objectPath, 3600);

  if (error) {
    console.error('Failed to sign storage asset', { bucket, objectPath, value, error });
    return null;
  }

  return data?.signedUrl ?? null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: RequestPayload;

  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { token, editionId } = payload;

  if (!token || !editionId) {
    return new Response(JSON.stringify({ error: 'token and editionId are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: tokenRecord, error: tokenError } = await supabase
    .from('tokens')
    .select('id, user_id, pdf_id, expires_at, revoked')
    .eq('token', token)
    .maybeSingle<SupabaseTokenRecord>();

  if (tokenError || !tokenRecord) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (tokenRecord.revoked) {
    return new Response(JSON.stringify({ error: 'Token revoked' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const expiresAt = new Date(tokenRecord.expires_at).getTime();
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
    return new Response(JSON.stringify({ error: 'Token expired' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: editionRecord, error: editionError } = await supabase
    .from('editions')
    .select('id, titre, date_publication, nb_pages, pdf_id')
    .eq('id', editionId)
    .maybeSingle();

  if (editionError || !editionRecord) {
    return new Response(JSON.stringify({ error: 'Edition not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (tokenRecord.pdf_id !== editionRecord.pdf_id) {
    return new Response(JSON.stringify({ error: 'Token does not grant access to this edition' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: pages, error: pagesError } = await supabase
    .from('pages')
    .select('id, page_number, image_url, thumbnail_url, width, height')
    .eq('edition_id', editionId)
    .order('page_number');

  if (pagesError) {
    return new Response(JSON.stringify({ error: 'Failed to load pages' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: articles, error: articlesError } = await supabase
    .from('articles')
    .select(
      `
      id,
      titre,
      sous_titre,
      ordre_lecture,
      position_x,
      position_y,
      width,
      height,
      page_id,
      pages!inner(page_number)
    `
    )
    .eq('edition_id', editionId);

  if (articlesError) {
    return new Response(JSON.stringify({ error: 'Failed to load article metadata' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const pageMap = new Map<string, number>();
  pages.forEach((page) => {
    if (typeof page.page_number === 'number') {
      pageMap.set(page.id, page.page_number);
    }
  });

  const pageManifests = pages.map((page) => ({
    id: page.id,
    pageNumber: page.page_number ?? 0,
    width: page.width ?? null,
    height: page.height ?? null,
    rawImagePath: page.image_url ?? null,
    rawThumbnailPath: page.thumbnail_url ?? null,
    lowResImageUrl: '',
    thumbnailUrl: null as string | null,
    tiles: [],
    hotspots: [] as Array<{
      id: string;
      title: string;
      x: number;
      y: number;
      width: number;
      height: number;
      articleId: string;
    }>,
  }));

  const articleSummaries: Record<
    string,
    {
      id: string;
      title: string;
      subtitle: string | null;
      order: number | null;
      pageNumber: number | null;
    }
  > = {};

  articles.forEach((article) => {
    const pageNumberFromJoin = (article as any).pages?.page_number as number | undefined;
    const pageNumber =
      pageNumberFromJoin ??
      (article.page_id ? pageMap.get(article.page_id) ?? null : null);

    if (
      typeof pageNumber === 'number' &&
      pageNumber >= 1 &&
      pageNumber <= pageManifests.length
    ) {
      const pageManifest = pageManifests[pageNumber - 1];
      pageManifest.hotspots.push({
        id: `${article.id}-hotspot`,
        title: article.titre ?? 'Article',
        x: clamp01(article.position_x ?? 0),
        y: clamp01(article.position_y ?? 0),
        width: normalizeLength(article.width ?? 0),
        height: normalizeLength(article.height ?? 0),
        articleId: article.id,
      });
    }

    articleSummaries[article.id] = {
      id: article.id,
      title: article.titre ?? 'Article',
      subtitle: article.sous_titre ?? null,
      order: article.ordre_lecture ?? null,
      pageNumber: pageNumber ?? null,
    };
  });


  const resolvedPages = await Promise.all(pageManifests.map(async (page) => {
    const lowSigned = await resolveStorageAsset(page.rawImagePath ?? page.rawThumbnailPath);
    const thumbnailSigned = await resolveStorageAsset(page.rawThumbnailPath ?? page.rawImagePath);
    const { rawImagePath, rawThumbnailPath, ...rest } = page;
    return {
      ...rest,
      lowResImageUrl: lowSigned ?? rawImagePath ?? rawThumbnailPath ?? '',
      thumbnailUrl: thumbnailSigned ?? rawThumbnailPath ?? null,
    };
  }));

  const manifest = {
    edition: {
      id: editionRecord.id,
      title: editionRecord.titre,
      publicationDate: editionRecord.date_publication,
      totalPages: pageManifests.length || editionRecord.nb_pages || 0,
    },
    pages: resolvedPages,
    articles: articleSummaries,
  };

  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

