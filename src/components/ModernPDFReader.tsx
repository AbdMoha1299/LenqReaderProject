import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
 AlertCircle,
 ChevronLeft,
 ChevronRight,
 ZoomIn,
 ZoomOut,
 Maximize,
 Minimize,
 RotateCw,
 BookOpen,
 X,
 LayoutGrid,
} from 'lucide-react';
import { supabase, Edition } from '../lib/supabase';
import { ArticleReader } from './ArticleReader';

interface ReaderAccessData {
 tokenId?: string;
 pdfId?: string;
 pdfUrl: string;
 pdfTitle?: string;
 userId: string;
 userName?: string;
 userNumber?: string;
 expiresAt?: string;
 editionId?: string | null;
 editionTitle?: string;
 hasArticles?: boolean;
}

interface ModernPDFReaderProps {
 token: string;
 initialData?: ReaderAccessData;
}

interface TokenData {
 id: string;
 pdf_id: string;
 user_id: string;
 expires_at: string;
 pdfs: {
  titre: string;
  url_fichier: string;
 } | null;
 users: {
  nom: string;
  numero_abonne: string;
 } | null;
}

interface ArticleHotspot {
 id: string;
 titre: string;
 x: number;
 y: number;
 width: number;
 height: number;
 ordre: number;
}

type EditionSummary = Pick<Edition, 'id' | 'titre' | 'date_publication' | 'date_edition'>;

const clamp01 = (value: number | null | undefined) =>
  Math.max(0, Math.min(1, value ?? 0));

const formatEditionDateLabel = (isoDate?: string | null) => {
 if (!isoDate) return '';
 try {
  const formatted = new Intl.DateTimeFormat('fr-FR', {
   weekday: 'long',
   day: '2-digit',
   month: 'long',
   year: 'numeric',
  }).format(new Date(isoDate));

  return formatted
   .split(' ')
   .map(part => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
   .join(' ');
 } catch {
  return '';
 }
};

const ALLOWED_EDITION_STATUSES = new Set<Edition['statut'] | string>(['published', 'ready', 'processing']);

const buildPdfPathCandidates = (rawPath: string | null | undefined) => {
 const result = new Set<string>();
 const trimmed = rawPath?.trim?.() ?? '';
 if (!trimmed) {
  return { paths: [], fileName: null as string | null };
 }

 const withoutQuery = trimmed.split('?')[0];
 const decoded = (() => {
  try {
   return decodeURIComponent(withoutQuery);
  } catch {
   return withoutQuery;
  }
 })();

 const pushCandidate = (candidate?: string | null) => {
  const normalized = candidate?.trim();
  if (normalized) {
   result.add(normalized);
  }
 };

 pushCandidate(trimmed);
 pushCandidate(withoutQuery);
 pushCandidate(decoded);

 const bucketMarker = '/secure-pdfs/';
 const legacyBucketMarker = 'secure-pdfs/';

 const extractAfterBucket = (value: string, marker: string) => {
  const index = value.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;
  return value.slice(index + marker.length);
 };

 const afterBucket =
  extractAfterBucket(decoded, bucketMarker) ?? extractAfterBucket(decoded, legacyBucketMarker);

 if (afterBucket) {
  pushCandidate(afterBucket);
  pushCandidate(`secure-pdfs/${afterBucket}`);
 }

 const fileName = decoded.split('/').pop() ?? null;
 return { paths: Array.from(result), fileName };
};

let pdfJsLibPromise: Promise<void> | null = null;
const ACCESS_CACHE_KEY_PREFIX = 'modern-pdf-token:';
const ACCESS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const ensurePdfJsLib = (): Promise<void> => {
 if (typeof window === 'undefined') return Promise.resolve();
 if ((window as any).pdfjsLib) return Promise.resolve();

 if (!pdfJsLibPromise) {
  pdfJsLibPromise = new Promise((resolve, reject) => {
   const existing = document.querySelector<HTMLScriptElement>('script[data-pdfjs]');
   if (existing) {
    existing.addEventListener('load', () => resolve());
    existing.addEventListener('error', reject);
    return;
   }

   const script = document.createElement('script');
   script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
   script.async = true;
   script.dataset.pdfjs = 'true';
   script.onload = () => {
    const pdfjsLib = (window as any).pdfjsLib;
    if (pdfjsLib) {
     pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
     resolve();
    } else {
     reject(new Error('pdfjsLib unavailable apres chargement du script'));
    }
   };
   script.onerror = reject;
   document.head.appendChild(script);
 });
}

return pdfJsLibPromise;
};

const readCachedAccessData = (token: string): ReaderAccessData | null => {
 if (typeof window === 'undefined') return null;
 try {
  const raw = window.sessionStorage.getItem(`${ACCESS_CACHE_KEY_PREFIX}${token}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { payload: ReaderAccessData; ts: number };
  if (!parsed || typeof parsed.ts !== 'number' || !parsed.payload) {
   return null;
  }
  if (Date.now() - parsed.ts > ACCESS_CACHE_TTL) {
   window.sessionStorage.removeItem(`${ACCESS_CACHE_KEY_PREFIX}${token}`);
   return null;
  }
  return parsed.payload;
 } catch (err) {
  console.warn('Failed to read access cache', err);
  return null;
 }
};

const writeCachedAccessData = (token: string, payload: ReaderAccessData) => {
 if (typeof window === 'undefined') return;
 try {
  const record = JSON.stringify({ payload, ts: Date.now() });
  window.sessionStorage.setItem(`${ACCESS_CACHE_KEY_PREFIX}${token}`, record);
 } catch (err) {
  console.warn('Failed to cache access data', err);
 }
};

export function ModernPDFReader({ token, initialData }: ModernPDFReaderProps) {
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [tokenData, setTokenData] = useState<TokenData | null>(null);
 const [pdfUrl, setPdfUrl] = useState('');
 const [editionId, setEditionId] = useState<string | null>(null);
 const [hasArticles, setHasArticles] = useState(false);
 const [viewMode, setViewMode] = useState<'pdf' | 'article'>('pdf');
 const [currentPageState, setCurrentPageState] = useState(1);
 const [totalPages, setTotalPages] = useState(0);
 const [scale, setScale] = useState(1);
 const [rotation, setRotation] = useState(0);
 const [isFullscreen, setIsFullscreen] = useState(false);
 const [sessionId, setSessionId] = useState('');
 const isRenderingRef = useRef(false);
 const pendingRenderRef = useRef<{ page: number; rotation: number; scale: number } | null>(null);
 const [pdfReady, setPdfReady] = useState(false);
 const [checkingArticles, setCheckingArticles] = useState(false);
 const [articleHotspots, setArticleHotspots] = useState<Record<number, ArticleHotspot[]>>({});
 const [initialArticleId, setInitialArticleId] = useState<string | null>(null);
 const [pendingArticleId, setPendingArticleId] = useState<string | null>(null);
 const [editionInfo, setEditionInfo] = useState<EditionSummary | null>(null);
 const lastHotspotEditionRef = useRef<string | null>(null);

 const firstArticleId = useMemo(() => {
  const pageNumbers = Object.keys(articleHotspots)
   .map(Number)
   .sort((a, b) => a - b);

  for (const page of pageNumbers) {
   const list = articleHotspots[page];
   if (list && list.length > 0) {
    return list[0].id;
   }
  }
  return null;
 }, [articleHotspots]);

 const articlePageMap = useMemo(() => {
  const map = new Map<string, number>();
  Object.entries(articleHotspots).forEach(([page, list]) => {
   list.forEach((hotspot) => {
    map.set(hotspot.id, Number(page));
   });
  });
  return map;
 }, [articleHotspots]);

 const editionDateLabel = useMemo(() => {
  const sourceDate = editionInfo?.date_publication || editionInfo?.date_edition;
  const formatted = formatEditionDateLabel(sourceDate);
  if (formatted) {
   return formatted;
  }
  return editionInfo?.titre || '';
 }, [editionInfo]);

 const containerRef = useRef<HTMLDivElement>(null);
 const canvasRef = useRef<HTMLCanvasElement>(null);
 const touchStartRef = useRef({ x: 0, y: 0, distance: 0, time: 0 });
 const scaleRef = useRef(1);
 const rotationRef = useRef(0);
 const currentPageRef = useRef(1);
 const lastRenderRef = useRef<{
  page: number;
  rotation: number;
  scale: number;
  containerWidth: number;
  containerHeight: number;
 } | null>(null);
 const isMobile = typeof window !== 'undefined' ? window.innerWidth < 768 : false;

 const clampPage = useCallback(
  (page: number) => {
    if (!totalPages || totalPages <= 1) return 1;
    if (page <= 1) return 1;
    if (page >= totalPages) return totalPages;
    return page;
  },
  [totalPages]
);

 const setCurrentPage = useCallback(
  (value: number | ((prev: number) => number)) => {
    if (typeof value === 'function') {
      setCurrentPageState(prev => clampPage(value(prev)));
    } else {
      setCurrentPageState(clampPage(value));
    }
  },
  [clampPage]
 );

const currentPage = currentPageState;
useEffect(() => {
 currentPageRef.current = currentPage;
}, [currentPage]);

 const setupSecurityMeasures = useCallback(() => {
  if (typeof document === 'undefined') {
   return undefined;
  }

  const stopEvent = (event: Event) => {
   event.preventDefault();
   event.stopPropagation();
  };

  const handleKeydown = (event: KeyboardEvent) => {
   const key = event.key.toLowerCase();

   if (event.key === 'PrintScreen') {
    stopEvent(event);
    return;
   }

   if ((event.ctrlKey || event.metaKey) && ['p', 's', 'o', 'c'].includes(key)) {
    stopEvent(event);
   }
  };

  const handleContextMenu = (event: MouseEvent) => stopEvent(event);
  const handleClipboard = (event: Event) => stopEvent(event);

  document.addEventListener('contextmenu', handleContextMenu);
  document.addEventListener('copy', handleClipboard);
  document.addEventListener('cut', handleClipboard);
  document.addEventListener('keydown', handleKeydown);

  return () => {
   document.removeEventListener('contextmenu', handleContextMenu);
   document.removeEventListener('copy', handleClipboard);
   document.removeEventListener('cut', handleClipboard);
   document.removeEventListener('keydown', handleKeydown);
  };
 }, []);

const resolvePdfUrl = useCallback(async (storagePath: string) => {
  const trimmedPath = storagePath?.trim?.() ?? '';
  if (!trimmedPath) {
   throw new Error('Chemin du PDF invalide');
  }

  try {
   const { data, error } = await supabase.storage
    .from('secure-pdfs')
    .createSignedUrl(trimmedPath, 60 * 60);

   if (!error && data?.signedUrl) {
    return data.signedUrl;
   }

   if (error) {
    console.warn('Echec de generation de l URL signee, tentative de fallback', error);
   }
  } catch (err) {
   console.warn('Echec de generation de l URL signee, tentative de fallback', err);
  }

  const { data: publicData } = supabase.storage
   .from('secure-pdfs')
   .getPublicUrl(trimmedPath);

  if (publicData?.publicUrl) {
   return publicData.publicUrl;
  }

  if (/^https?:\/\//i.test(trimmedPath)) {
   return trimmedPath;
  }

 throw new Error('Impossible de generer une URL pour le PDF demande');
}, []);

const fetchIpAddress = useCallback(async () => {
 if (typeof fetch === 'undefined') return '';

 const supportsAbort = typeof AbortController !== 'undefined';
 const controller = supportsAbort ? new AbortController() : null;
 let timeoutId: ReturnType<typeof setTimeout> | undefined;

 try {
  if (supportsAbort) {
   timeoutId = setTimeout(() => {
    try {
     controller?.abort();
    } catch {
     /* ignore abort errors */
    }
   }, 4000);
  }

  const response = await fetch('https://api.ipify.org?format=json', {
   signal: controller?.signal,
  });

  if (!response.ok) {
   return '';
  }

  const result = await response.json();
  return result?.ip ?? '';
 } catch (ipErr) {
  if (ipErr instanceof DOMException && ipErr.name === 'AbortError') {
   console.warn('Recuperation de l adresse IP interrompue (timeout)');
  } else {
   console.warn('Impossible de recuperer l adresse IP', ipErr);
  }
  return '';
 } finally {
  if (timeoutId) {
   clearTimeout(timeoutId);
  }
 }
}, []);

const fetchEditionMetadata = useCallback(
async (editionIdCandidate: string | null | undefined, pdfPath: string) => {
  const applyEditionRecord = (record: {
   id: string;
   titre: string;
   date_publication: string | null;
   date_edition: string | null;
   statut?: Edition['statut'] | string | null;
  } | null) => {
   if (!record) return null;

   if (record.statut && !ALLOWED_EDITION_STATUSES.has(record.statut)) {
    console.warn(
     'Edition chargee avec un statut hors liste autorisee',
     { editionId: record.id, statut: record.statut }
    );
   }

   setEditionId(record.id);
   setEditionInfo({
    id: record.id,
    titre: record.titre,
    date_publication: record.date_publication,
    date_edition: record.date_edition,
   });
   return record.id;
  };

  const tryFetchByPdfPaths = async (
   paths: string[],
   restrictStatus: boolean
  ) => {
   if (!paths.length) return null;

   let query = supabase
    .from('editions')
    .select('id, titre, date_publication, date_edition, statut, pdf_url, updated_at')
    .in('pdf_url', paths)
    .order('updated_at', { ascending: false });

   if (restrictStatus) {
    query = query.in('statut', Array.from(ALLOWED_EDITION_STATUSES));
   }

   const { data, error } = await query.limit(10);
   if (error || !Array.isArray(data) || data.length === 0) {
    return null;
   }

   for (const record of data) {
    const appliedId = applyEditionRecord(record);
    if (appliedId) {
     return appliedId;
    }
   }
   return null;
  };

  try {
   if (editionIdCandidate) {
    const { data, error } = await supabase
     .from('editions')
     .select('id, titre, date_publication, date_edition, statut, pdf_url')
      .eq('id', editionIdCandidate)
      .maybeSingle();

     if (!error && data) {
      const appliedId = applyEditionRecord(data);
     if (appliedId) {
      return appliedId;
     }
    }
   }

   const { paths: pdfPathCandidates, fileName } = buildPdfPathCandidates(pdfPath);

   const allowedStatusMatch = await tryFetchByPdfPaths(pdfPathCandidates, true);
   if (allowedStatusMatch) {
    return allowedStatusMatch;
   }

   const relaxedStatusMatch = await tryFetchByPdfPaths(pdfPathCandidates, false);
   if (relaxedStatusMatch) {
    return relaxedStatusMatch;
   }

   if (fileName) {
    const { data: editionByName, error: editionByNameError } = await supabase
     .from('editions')
     .select('id, titre, date_publication, date_edition, statut, pdf_url, updated_at')
     .ilike('pdf_url', `%${fileName}%`)
     .order('updated_at', { ascending: false })
     .limit(10);

    if (!editionByNameError && Array.isArray(editionByName) && editionByName.length > 0) {
     for (const record of editionByName) {
      const appliedId = applyEditionRecord(record);
      if (appliedId) {
       return appliedId;
      }
     }
    }
   }
  } catch (err) {
   console.error('Error fetching edition metadata:', err);
  }

  setEditionId(editionIdCandidate ?? null);
   setEditionInfo(null);
   return editionIdCandidate ?? null;
  },
  []
 );

 const loadArticleHotspots = useCallback(async (targetEditionId: string) => {
  if (!targetEditionId) {
   setArticleHotspots({});
   setHasArticles(false);
   return;
  }

  setCheckingArticles(true);
  try {
   const { data, error } = await supabase
    .from('articles')
    .select(`
      id,
      titre,
      ordre_lecture,
      position_x,
      position_y,
      width,
      height,
      page_id
     `)
    .eq('edition_id', targetEditionId)
    .order('ordre_lecture', { ascending: true });

   if (error) {
    throw error;
   }

   const articlesData: Array<{
    id: string;
    titre: string;
    ordre_lecture: number | null;
    position_x: number | null;
    position_y: number | null;
    width: number | null;
    height: number | null;
    page_id: string | null;
   }> = Array.isArray(data) ? data : [];

   const uniquePageIds = Array.from(
    new Set(
     articlesData
      .map((article) => article.page_id)
      .filter((pageId): pageId is string => Boolean(pageId))
    )
   );

   let pageNumberMap = new Map<string, number>();
   if (uniquePageIds.length > 0) {
    const { data: pagesData, error: pagesError } = await supabase
     .from('pages')
     .select('id, page_number')
     .in('id', uniquePageIds);

    if (pagesError) {
     console.warn('Impossible de charger les numeros de page pour les hotspots', pagesError);
    } else if (Array.isArray(pagesData)) {
     pageNumberMap = new Map(
      pagesData
       .filter((page) => page && typeof page.page_number === 'number')
       .map((page) => [page.id, Math.max(1, Math.floor(page.page_number))])
     );
    }
   }

   const hotspotsMap: Record<number, ArticleHotspot[]> = {};
   const ignoredHotspots: string[] = [];

   articlesData.forEach((article) => {
    if (!article) return;

    const normalizedWidth = clamp01(article.width);
    const normalizedHeight = clamp01(article.height);

    if (normalizedWidth <= 0 || normalizedHeight <= 0) {
     ignoredHotspots.push(article.id);
     return;
    }

    const normalizedX = clamp01(article.position_x);
    const normalizedY = clamp01(article.position_y);

    const resolvedPageNumber = article.page_id ? pageNumberMap.get(article.page_id) : undefined;
    const safePageNumber =
     typeof resolvedPageNumber === 'number' && resolvedPageNumber > 0
      ? resolvedPageNumber
      : Math.max(1, Number(article?.ordre_lecture) || 1);

    const hotspot: ArticleHotspot = {
     id: article.id,
     titre: article.titre,
     x: normalizedX,
     y: normalizedY,
     width: normalizedWidth,
     height: normalizedHeight,
     ordre: article.ordre_lecture ?? 0,
    };

    if (!hotspotsMap[safePageNumber]) {
     hotspotsMap[safePageNumber] = [];
    }
    hotspotsMap[safePageNumber].push(hotspot);
   });

   Object.values(hotspotsMap).forEach((list) => list.sort((a, b) => a.ordre - b.ordre));

   if (ignoredHotspots.length > 0) {
    console.warn('Hotspots ignores (dimensions nulles ou invalides):', {
     editionId: targetEditionId,
     articleIds: ignoredHotspots,
    });
   }

   const hasValidHotspots = Object.values(hotspotsMap).some((list) => list.length > 0);

   setArticleHotspots(hasValidHotspots ? hotspotsMap : {});
   setHasArticles(articlesData.length > 0);
  } catch (err) {
   console.error('Error loading article hotspots:', err);
   setArticleHotspots({});
   setHasArticles(false);
  } finally {
   setCheckingArticles(false);
  }
 }, []);

 const applyAccessData = useCallback(
  async (payload: ReaderAccessData) => {
   const metadataPromise = fetchEditionMetadata(payload.editionId ?? null, payload.pdfUrl);

   const tokenRecord: TokenData = {
    id: payload.tokenId ?? '',
    pdf_id: payload.pdfId ?? '',
    user_id: payload.userId,
    expires_at: payload.expiresAt ?? '',
    pdfs: {
     titre: payload.pdfTitle ?? '',
     url_fichier: payload.pdfUrl,
    },
    users: {
     nom: payload.userName ?? '',
     numero_abonne: payload.userNumber ?? '',
    },
   };

   setTokenData(tokenRecord);
   setHasArticles(payload.hasArticles ?? false);
   setInitialArticleId(null);
   setPdfUrl(payload.pdfUrl);

   metadataPromise
    .then(async (editionIdResolved) => {
     if (!editionIdResolved && payload.editionTitle) {
      setEditionInfo({
       id: payload.editionId ?? '',
       titre: payload.editionTitle,
       date_publication: null,
       date_edition: null,
      });
      return;
     }

     if (editionIdResolved) {
      if (payload.hasArticles !== false) {
       try {
        await loadArticleHotspots(editionIdResolved);
       } catch (err) {
        console.error('Erreur lors du chargement des hotspots (deferred)', err);
        setArticleHotspots({});
       }
      } else {
       setArticleHotspots({});
      }
     } else {
      setArticleHotspots({});
      setHasArticles(payload.hasArticles ?? false);
     }
    })
    .catch((err) => {
     console.error('Error resolving edition metadata (deferred)', err);
     if (payload.hasArticles === false) {
      setArticleHotspots({});
      setHasArticles(false);
     }
    });
  },
  [fetchEditionMetadata, loadArticleHotspots]
 );

 const validateToken = useCallback(async () => {
  if (!token) {
   setError('Lien invalide');
   setLoading(false);
   return;
  }

  setLoading(true);
  setError('');
  setTokenData(null);
  setArticleHotspots({});
  setHasArticles(false);
  setEditionInfo(null);
  setEditionId(null);
  lastHotspotEditionRef.current = null;

  try {
   if (initialData?.pdfUrl) {
    setHasArticles(initialData.hasArticles ?? false);
    await applyAccessData(initialData);
    return;
   }

   ensurePdfJsLib().catch((err) => console.error('Erreur de prechargement pdf.js (validation)', err));

   const cached = readCachedAccessData(token);
   if (cached?.pdfUrl) {
    setHasArticles(cached.hasArticles ?? false);
    await applyAccessData(cached);
    setLoading(false);
    return;
   }

   const screenInfo =
    typeof window !== 'undefined' && window.screen
     ? `${window.screen.width}x${window.screen.height}`
     : '';
   const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
   const language = typeof navigator !== 'undefined' ? navigator.language : 'fr-FR';

   const deviceFingerprint = {
    userAgent,
    screenResolution: screenInfo,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language,
   };

   const ipFetchPromise = fetchIpAddress();
   const ipAddress = await Promise.race<string | undefined>([
    ipFetchPromise,
    new Promise<string>((resolve) => {
     setTimeout(() => resolve(''), 1200);
    }),
   ]).then((value) => value ?? '');

   const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-edition-access`,
    {
     method: 'POST',
     headers: {
      'Content-Type': 'application/json',
     },
     body: JSON.stringify({
      token,
      deviceFingerprint,
      ipAddress,
     }),
    }
   );

   const data = await response.json();

   if (!response.ok || data?.error) {
    setError(data?.error || 'Token invalide');
    return;
   }

   setHasArticles(Boolean(data?.hasArticles));

   const accessPayload: ReaderAccessData = {
    tokenId: data?.tokenId,
    pdfId: data?.pdfId,
    pdfUrl: data?.pdfUrl,
    pdfTitle: data?.pdfTitle,
    userId: data?.userId,
    userName: data?.userName,
    userNumber: data?.userNumber,
    expiresAt: data?.expiresAt,
    editionId: data?.editionId ?? null,
    editionTitle: data?.editionTitle,
    hasArticles: data?.hasArticles,
   };

   writeCachedAccessData(token, accessPayload);

   await applyAccessData(accessPayload);

   // If IP was not ready for the validation request, resolve quietly (best effort logging)
   ipFetchPromise.catch(() => undefined);
  } catch (err) {
   console.error('Error validating token:', err);
   const message =
    err instanceof Error ? err.message : 'Erreur lors de la validation du token';
   setError(message);
  } finally {
   setLoading(false);
  }
}, [applyAccessData, fetchIpAddress, initialData, token]);

 useEffect(() => {
  validateToken().catch((err) => console.error('Validation error', err));
  setSessionId(crypto.randomUUID());
  const teardownSecurity = setupSecurityMeasures();

  return () => {
   teardownSecurity?.();
  };
 }, [setupSecurityMeasures, token, validateToken]);

useEffect(() => {
 ensurePdfJsLib().catch(err => console.error('Erreur de prechargement de pdf.js', err));
}, []);

 useEffect(() => {
  setCurrentPageState(prev => clampPage(prev));
 }, [clampPage]);

const goToPreviousPage = useCallback(() => {
  setCurrentPage(prev => (prev <= 1 ? 1 : prev - 1));
}, [setCurrentPage]);

const goToNextPage = useCallback(() => {
  setCurrentPage(prev => {
    if (!totalPages || prev >= totalPages) return prev;
    return prev + 1;
  });
}, [setCurrentPage, totalPages]);

const pageRangeLabel = `${currentPage}`;

const hasPreviousPage = currentPage > 1;
const hasNextPage = totalPages ? currentPage < totalPages : false;

const previousPageLabel = `P ${Math.max(1, currentPage - 1)}`;
const nextPageLabel = `P ${totalPages ? Math.min(totalPages, currentPage + 1) : currentPage + 1}`;
const hotspotsForCurrentPage = articleHotspots[currentPage] || [];


const applyWatermark = useCallback(
 (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, pageNumber: number) => {
  if (!tokenData?.users?.nom) return;

  context.save();
  context.globalAlpha = 0.08;

  const fontSize = Math.max(14, Math.min(canvas.width * 0.02, 24));
  context.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  context.fillStyle = '#64748B';
  context.textAlign = 'center';

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  context.translate(centerX, centerY);
  context.rotate(-Math.PI / 8);

  const sessionShort = sessionId.substring(0, 8).toUpperCase();
  const timestamp = new Date().toLocaleString('fr-FR');

  context.fillText(tokenData.users.nom.toUpperCase(), 0, -fontSize * 1.5);
  context.fillText(`${tokenData.users.numero_abonne || 'N/A'}`, 0, 0);
  context.fillText(`${timestamp}`, 0, fontSize * 1.5);
  context.fillText(`ID: ${sessionShort} - P${pageNumber}`, 0, fontSize * 3);

  context.restore();
 },
 [sessionId, tokenData]
);
useEffect(() => {
 scaleRef.current = scale;
}, [scale]);

useEffect(() => {
 rotationRef.current = rotation;
}, [rotation]);

const renderPage = useCallback(
 async (pageNumber: number, renderRotation: number, renderScale: number) => {
 const pdf = (window as any).pdfDocument;
 if (!pdf) return;

 const canvas = canvasRef.current;
 if (!canvas) {
  pendingRenderRef.current = { page: pageNumber, rotation: renderRotation, scale: renderScale };
  return;
 }

 const containerWidth = containerRef.current?.clientWidth ?? window.innerWidth - 32;
 const containerHeight = window.innerHeight - (isMobile ? 140 : 180);
 const lastRender = lastRenderRef.current;

 if (
  lastRender &&
  lastRender.page === pageNumber &&
  lastRender.rotation === renderRotation &&
  lastRender.scale === renderScale &&
  lastRender.containerWidth === containerWidth &&
  lastRender.containerHeight === containerHeight
 ) {
  return;
 }

 if (isRenderingRef.current) {
  pendingRenderRef.current = { page: pageNumber, rotation: renderRotation, scale: renderScale };
  return;
 }

 isRenderingRef.current = true;

 try {
  const page = await pdf.getPage(pageNumber);
  const context = canvas.getContext('2d');
  if (!context) {
    isRenderingRef.current = false;
    return;
  }

  const baseViewport = page.getViewport({ scale: 1, rotation: renderRotation });

  const baseScaleRaw = Math.min(
   containerWidth / baseViewport.width,
   containerHeight / baseViewport.height
  );

   const baseScale = Math.max(Math.min(baseScaleRaw, 1) * 0.98, 0.1);
   const effectiveScale = baseScale * renderScale;
   const viewport = page.getViewport({ scale: effectiveScale, rotation: renderRotation });

   const dpr = window.devicePixelRatio || 1;
   canvas.width = Math.max(1, Math.round(viewport.width * dpr));
   canvas.height = Math.max(1, Math.round(viewport.height * dpr));
   canvas.style.width = `${viewport.width}px`;
   canvas.style.height = `${viewport.height}px`;

   context.setTransform(dpr, 0, 0, dpr, 0, 0);
   context.clearRect(0, 0, viewport.width, viewport.height);

  await page.render({
   canvasContext: context,
   viewport,
  }).promise;

  applyWatermark(context, canvas, pageNumber);
  lastRenderRef.current = {
   page: pageNumber,
   rotation: renderRotation,
   scale: renderScale,
   containerWidth,
   containerHeight,
  };
  setPdfReady(true);
 } catch (err) {
  console.error('Error rendering page:', err);
 } finally {
  isRenderingRef.current = false;

   if (pendingRenderRef.current) {
    const next = pendingRenderRef.current;
    pendingRenderRef.current = null;
    await renderPage(next.page, next.rotation, next.scale);
   }
 }
 },
 [applyWatermark, isMobile]
);
const latestRenderPageRef = useRef(renderPage);
useEffect(() => {
 latestRenderPageRef.current = renderPage;
}, [renderPage]);

useEffect(() => {
 if (!pdfUrl) return;

 let cancelled = false;

 const initializePDF = async () => {
  try {
   await ensurePdfJsLib();

   if ((window as any).pdfDocument?.destroy) {
    try {
     await (window as any).pdfDocument.destroy();
    } catch (destroyErr) {
     console.warn('Error while destroying previous PDF instance', destroyErr);
    }
   }

   const loadingTask = window.pdfjsLib.getDocument({
    url: pdfUrl,
    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
    cMapPacked: true,
   });

   const pdf = await loadingTask.promise;
   if (cancelled) {
    await pdf.destroy?.();
    return;
   }

  (window as any).pdfDocument = pdf;
  setTotalPages(pdf.numPages);
  setCurrentPageState(1);
  currentPageRef.current = 1;
  lastRenderRef.current = null;
  setPdfReady(false);
  await latestRenderPageRef.current(1, rotationRef.current, scaleRef.current);
 } catch (err) {
   if (!cancelled) {
    console.error('Error loading PDF:', err);
    setError('Erreur lors du chargement du PDF');
   }
  }
 };

 initializePDF().catch((err) => {
  if (!cancelled) {
   console.error('Initialisation du PDF echouee', err);
  }
 });

 return () => {
  cancelled = true;
 };
}, [pdfUrl]);

useEffect(() => {
 if (!pdfUrl || viewMode !== 'pdf' || loading) return;
 renderPage(currentPage, rotation, scale);
}, [currentPage, loading, pdfUrl, renderPage, rotation, scale, viewMode]);

useEffect(() => {
 if (loading || viewMode !== 'pdf') return;
 const pending = pendingRenderRef.current;
 if (!pending || !canvasRef.current) return;

 pendingRenderRef.current = null;
 renderPage(pending.page, pending.rotation, pending.scale);
}, [loading, renderPage, viewMode]);
useEffect(() => {
  if (!editionId || lastHotspotEditionRef.current === editionId) return;

  loadArticleHotspots(editionId)
    .then(() => {
      lastHotspotEditionRef.current = editionId;
    })
    .catch(err => console.error('Erreur lors du rafraichissement des hotspots', err));
}, [editionId, loadArticleHotspots]);


useEffect(() => {
  if (!editionId) return;
  loadArticleHotspots(editionId).catch(err =>
    console.error('Erreur lors du rafraichissement des hotspots', err)
  );
}, [editionId, loadArticleHotspots]);

useEffect(() => {
  if (viewMode === 'article' && editionId && pendingArticleId && pendingArticleId !== initialArticleId) {
    setInitialArticleId(pendingArticleId);
    setPendingArticleId(null);
  }
}, [viewMode, editionId, pendingArticleId, initialArticleId]);


 const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 3));
 const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.5));
 const handleRotate = () => setRotation(prev => (prev + 90) % 360);

 const toggleFullscreen = () => {
  if (!document.fullscreenElement) {
   document.documentElement.requestFullscreen();
   setIsFullscreen(true);
  } else {
   document.exitFullscreen();
   setIsFullscreen(false);
  }
 };

 useEffect(() => {
  const handleFullscreenChange = () => {
   setIsFullscreen(Boolean(document.fullscreenElement));
  };

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
 }, []);

 const handleExit = () => {
  if (document.fullscreenElement) {
   document.exitFullscreen().catch(() => undefined);
   setIsFullscreen(false);
  }

  if (window.history.length > 1) {
   window.history.back();
  } else {
   window.location.href = '/';
  }
 };

 const handleTouchStart = (e: React.TouchEvent) => {
  if (e.touches.length === 2) {
   const dx = e.touches[0].clientX - e.touches[1].clientX;
   const dy = e.touches[0].clientY - e.touches[1].clientY;
   touchStartRef.current.distance = Math.sqrt(dx * dx + dy * dy);
   touchStartRef.current.time = Date.now();
   scaleRef.current = scale;
  } else if (e.touches.length === 1) {
   touchStartRef.current.x = e.touches[0].clientX;
   touchStartRef.current.y = e.touches[0].clientY;
   touchStartRef.current.time = Date.now();
  }
 };

 const handleTouchMove = (e: React.TouchEvent) => {
  if (e.touches.length === 2 && touchStartRef.current.distance > 0) {
   const dx = e.touches[0].clientX - e.touches[1].clientX;
   const dy = e.touches[0].clientY - e.touches[1].clientY;
   const newDistance = Math.sqrt(dx * dx + dy * dy);
   const scaleMultiplier = newDistance / touchStartRef.current.distance;

   const newScale = Math.max(0.5, Math.min(3, scaleRef.current * scaleMultiplier));
   setScale(newScale);
  }
 };

 const handleTouchEnd = (e: React.TouchEvent) => {
  if (e.changedTouches.length === 1 && touchStartRef.current.distance === 0) {
   const touchEndX = e.changedTouches[0].clientX;
   const touchEndY = e.changedTouches[0].clientY;
   const deltaX = touchEndX - touchStartRef.current.x;
   const deltaY = Math.abs(touchEndY - touchStartRef.current.y);
   if (Math.abs(deltaX) > 100 && deltaY < 80) {
    if (deltaX > 0) {
     goToPreviousPage();
    } else if (deltaX < 0) {
     goToNextPage();
    }
   }
  }

  touchStartRef.current = { x: 0, y: 0, distance: 0, time: 0 };
 };

 const handleHotspotClick = (hotspot: ArticleHotspot) => {
  setPendingArticleId(hotspot.id);
  if (editionId) {
    setInitialArticleId(hotspot.id);
  }
  setViewMode('article');
 };

 if (loading) {
  return (
   <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
    <div className="flex flex-col items-center gap-4">
     <div className="h-16 w-16 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
     <p className="text-[#1f3b63] text-sm sm:text-base font-medium">Chargement...</p>
    </div>
   </div>
  );
 }

 if (error) {
  return (
   <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center px-4">
    <div className="max-w-md w-full bg-white border border-[#f1c2c2] shadow-xl rounded-3xl px-8 py-10 text-center">
     <AlertCircle className="w-16 h-16 text-[#d14343] mx-auto mb-6" />
     <h2 className="text-xl font-semibold text-[#1f3b63] mb-2">Acces refuse</h2>
     <p className="text-sm text-[#60719d]">{error}</p>
    </div>
   </div>
  );
 }

const showArticle = viewMode === 'article';

const articleView = (() => {
 if (!tokenData) {
  return (
   <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
    <div className="text-[#1f3b63]">Chargement...</div>
   </div>
  );
 }

 if (!editionId) {
  return (
   <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
    <div className="flex flex-col items-center gap-4">
     <div className="h-16 w-16 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
     <p className="text-[#1f3b63] text-sm sm:text-base font-medium">Preparation des articles...</p>
    </div>
   </div>
  );
 }

 return (
  <ArticleReader
   editionId={editionId}
   userId={tokenData.user_id}
   userName={tokenData.users?.nom || ''}
   userNumber={tokenData.users?.numero_abonne || ''}
   sessionId={sessionId}
   onBackToPDF={() => {
    if (initialArticleId) {
     const page = articlePageMap.get(initialArticleId);
     if (page) {
      setCurrentPage(page);
     }
    }
    setPendingArticleId(null);
    setViewMode('pdf');
   }}
   initialArticleId={initialArticleId}
   onArticleChange={(articleId) => { setInitialArticleId(articleId); setPendingArticleId(null); }}
   editionLabel={editionDateLabel || tokenData.pdfs?.titre || ''}
  />
 );
})();

 const controlButtonClass =
  'h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] flex items-center justify-center shadow-sm transition hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed';
 const sideNavButtonBase =
  'absolute top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 px-3 py-4 rounded-full bg-white border border-[#d7deec] text-[#1f3b63] shadow-lg transition disabled:opacity-40 disabled:pointer-events-none';

 return (
  <>
   <div
    className={`min-h-screen bg-[#f1f2f6] text-[#1f3b63] flex flex-col select-none ${showArticle ? 'hidden' : ''}`}
    ref={containerRef}
    onTouchStart={handleTouchStart}
    onTouchMove={handleTouchMove}
    onTouchEnd={handleTouchEnd}
   >
   <header className="fixed top-0 left-0 right-0 z-40 bg-[#f5f7fb] border-b border-[#dfe5f2] shadow-sm">
    <div className="max-w-6xl mx-auto h-16 px-4 lg:px-6 flex items-center justify-between">
     <div className="flex items-center gap-4">
      <button
       type="button"
       onClick={handleExit}
       className="h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] flex items-center justify-center shadow-sm hover:shadow-md transition hover:-translate-x-0.5"
       title="Fermer la liseuse"
      >
       <X className="w-4 h-4" />
      </button>
      <div className="flex items-center gap-3 min-w-0">
       <span className="inline-flex px-3 py-1 rounded-full border border-[#d0d8e8] bg-white text-[#1f3b63] font-semibold text-xs sm:text-sm uppercase tracking-[0.18em]">
        L ENQUETEUR
       </span>
       {(editionDateLabel || tokenData?.pdfs?.titre) && (
        <span className="text-sm sm:text-base font-medium text-[#1f3b63] truncate">
         {editionDateLabel || tokenData?.pdfs?.titre}
        </span>
       )}
      </div>
     </div>

     <div className="flex items-center gap-3">
      <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#d7deec] bg-white text-xs font-semibold text-[#1f3b63] shadow-sm">
       <BookOpen className="w-4 h-4" />
       <span>{totalPages ? `Page ${pageRangeLabel} / ${totalPages}` : `Page ${pageRangeLabel}`}</span>
      </div>
      <button
       type="button"
       onClick={handleZoomOut}
       disabled={scale <= 0.5}
       className={controlButtonClass}
       title="Zoom arriere"
      >
       <ZoomOut className="w-4 h-4" />
      </button>
      <button
       type="button"
       onClick={handleZoomIn}
       disabled={scale >= 3}
       className={controlButtonClass}
       title="Zoom avant"
      >
       <ZoomIn className="w-4 h-4" />
      </button>
      <button
       type="button"
       onClick={handleRotate}
       className={controlButtonClass}
       title="Rotation"
      >
       <RotateCw className="w-4 h-4" />
      </button>
      <button
       type="button"
       onClick={toggleFullscreen}
       className={controlButtonClass}
       title={isFullscreen ? 'Quitter plein ecran' : 'Plein ecran'}
      >
       {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
      </button>
     </div>
    </div>
   </header>

   <main className="flex-1 w-full relative pt-24 pb-20 px-4">
    <div className="relative max-w-5xl mx-auto flex items-center justify-center">
     {hasPreviousPage && (
      <button
       type="button"
       onClick={goToPreviousPage}
       className={`${sideNavButtonBase} left-6 hover:-translate-x-1`}
       title="Pages precedentes"
      >
       <ChevronLeft className="w-5 h-5" />
       <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
        {previousPageLabel}
       </span>
      </button>
     )}

     <div className="relative border border-[#dfe5f2] bg-white shadow-[0_30px_80px_-35px_rgba(15,31,64,0.6)]">
     <canvas
      ref={canvasRef}
      className="block max-w-full h-auto transition-transform duration-300"
      style={{ backgroundColor: '#ffffff' }}
     />
     {!pdfReady && (
      <div className="absolute inset-0 flex items-center justify-center bg-white/85 backdrop-blur-[1px]">
       <div className="flex flex-col items-center gap-3">
        <div className="h-12 w-12 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
        <p className="text-xs font-medium text-[#1f3b63]">Preparation du PDF...</p>
       </div>
      </div>
     )}

     {viewMode === 'pdf' &&
      hotspotsForCurrentPage.map((hotspot) => (
        <button
         key={`${hotspot.id}-${hotspot.ordre}`}
         type="button"
         onClick={(event) => {
          event.stopPropagation();
          handleHotspotClick(hotspot);
         }}
         className="absolute border border-transparent bg-[#1f3b63]/0 hover:bg-[#1f3b63]/10 focus-visible:bg-[#1f3b63]/12 rounded-lg transition-colors duration-200"
         style={{
          left: `${clamp01(hotspot.x) * 100}%`,
          top: `${clamp01(hotspot.y) * 100}%`,
          width: `${clamp01(hotspot.width) * 100}%`,
          height: `${clamp01(hotspot.height) * 100}%`,
         }}
         title={hotspot.titre}
        >
         <span className="sr-only">{hotspot.titre}</span>
        </button>
       ))}
     </div>

     {hasNextPage && (
      <button
       type="button"
       onClick={goToNextPage}
       className={`${sideNavButtonBase} right-6 hover:translate-x-1`}
       title="Pages suivantes"
      >
       <ChevronRight className="w-5 h-5" />
       <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
        {nextPageLabel}
       </span>
      </button>
     )}
    </div>
   </main>

   {hasArticles && (
    <button
     type="button"
     onClick={() => {
      if (!initialArticleId && firstArticleId) {
       setPendingArticleId(firstArticleId);
       if (editionId) {
        setInitialArticleId(firstArticleId);
       }
      }
      setViewMode('article');
     }}
     disabled={checkingArticles}
     className="fixed bottom-10 right-6 z-30 h-14 w-14 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] shadow-lg hover:shadow-xl transition disabled:opacity-50"
     title="Mode article"
    >
     <LayoutGrid className="w-6 h-6 mx-auto" />
    </button>
   )}

   <style>{`
    @media print {
     * { display: none !important; }
    }

    * {
     user-select: none !important;
     -webkit-user-select: none !important;
    }

    canvas {
     -webkit-touch-callout: none !important;
    }
   `}</style>
   </div>

   {showArticle && articleView}
  </>
 );
}

declare global {
 interface Window {
  pdfjsLib: any;
  pdfDocument: any;
 }
}
