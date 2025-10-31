import { useState, useEffect, useRef, useCallback, useMemo, type SyntheticEvent } from 'react';
import {
 AlertCircle,
 ChevronLeft,
 ChevronRight,
 ZoomIn,
 ZoomOut,
 Maximize,
 Minimize,
 RotateCw,
 ChevronUp,
 ChevronDown,
 BookOpen,
 X,
} from 'lucide-react';
import { ArticleReader } from './ArticleReader';
import { supabase, Edition } from '../lib/supabase';
import { ensurePromiseWithResolvers } from '../utils/ensurePromiseWithResolvers';
import { AdvancedReader } from '../reader/AdvancedReader';
import { manifestService, preloadImage } from '../reader/services/manifestService';
import type { ReaderManifest } from '../reader/types';

ensurePromiseWithResolvers();

export interface ReaderAccessData {
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

const PDF_JS_VERSION = '4.10.38';
const PDF_JS_SCRIPT_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/pdf.min.js`;
const PDF_JS_WORKER_SRC = '/pdfjs/pdf.worker.min.mjs';

let pdfJsLibPromise: Promise<void> | null = null;
const ACCESS_CACHE_KEY_PREFIX = 'modern-pdf-token:';
const ACCESS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const configurePdfJsLib = (lib: any) => {
 try {
  if (lib?.GlobalWorkerOptions) {
   lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_SRC;
  }
  if (typeof lib.disableWorker === 'boolean') {
   lib.disableWorker = false;
  }
 } catch (err) {
  console.warn('Impossible de configurer pdf.js', err);
 }
};

const ensurePdfJsLib = (): Promise<void> => {
 ensurePromiseWithResolvers();
 if (typeof window === 'undefined') return Promise.resolve();

 const existingLib = (window as any).pdfjsLib;
 if (existingLib) {
  configurePdfJsLib(existingLib);
  return Promise.resolve();
 }

 if (!pdfJsLibPromise) {
  pdfJsLibPromise = new Promise((resolve, reject) => {
   const existingScript = document.querySelector<HTMLScriptElement>('script[data-pdfjs]');
   if (existingScript) {
    existingScript.addEventListener('load', () => {
     try {
      configurePdfJsLib((window as any).pdfjsLib);
      resolve();
     } catch (err) {
      reject(err);
     }
    });
    existingScript.addEventListener('error', reject);
    return;
   }

   const script = document.createElement('script');
   script.src = PDF_JS_SCRIPT_URL;
   script.async = true;
   script.crossOrigin = 'anonymous';
   script.dataset.pdfjs = 'true';
   script.onload = () => {
    const pdfjsLib = (window as any).pdfjsLib;
    if (pdfjsLib) {
     configurePdfJsLib(pdfjsLib);
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

interface RenderPlan {
 page: number;
 rotation: number;
 scale: number;
 containerWidth: number;
 containerHeight: number;
 pagesToRender: number[];
}

interface RenderTask {
 pdfDocument: any;
 canvas: HTMLCanvasElement;
 plan: RenderPlan;
 fingerprint: string;
 applyWatermark: (
  context: CanvasRenderingContext2D,
  bounds: { width: number; height: number; offsetX: number },
  pageNumber: number
 ) => void;
 devicePixelRatio: number;
}

class RenderQueue {
 private currentPromise: Promise<void> | null = null;
 private controller: AbortController | null = null;
 private queuedTask: RenderTask | null = null;

 constructor(
  private readonly worker: (task: RenderTask, signal: AbortSignal) => Promise<void>,
  private readonly handleComplete: (task: RenderTask) => void,
  private readonly handleError: (error: unknown, task: RenderTask) => void
 ) {}

 enqueue(task: RenderTask) {
  if (this.currentPromise) {
   this.controller?.abort();
   this.queuedTask = task;
   return;
  }

  this.start(task);
 }

 cancel() {
  this.controller?.abort();
  this.queuedTask = null;
  this.currentPromise = null;
  this.controller = null;
 }

 private start(task: RenderTask) {
  this.controller = new AbortController();
  const { signal } = this.controller;

  this.currentPromise = this.worker(task, signal)
   .then(() => {
    if (!signal.aborted) {
     this.handleComplete(task);
    }
   })
   .catch((error) => {
    if ((error as DOMException)?.name === 'AbortError') {
     return;
    }
    this.handleError(error, task);
   })
   .finally(() => {
    this.currentPromise = null;
    this.controller = null;
    const next = this.queuedTask;
    this.queuedTask = null;
    if (next) {
     this.start(next);
    }
  });
 }
}

const createPlanFingerprint = (plan: RenderPlan) =>
 `${plan.page}|${plan.rotation}|${plan.scale}|${plan.containerWidth}|${plan.containerHeight}|${plan.pagesToRender.join(',')}`;

interface CachedRender {
 bitmap: ImageBitmap;
 width: number;
 height: number;
 cssWidth: number;
 cssHeight: number;
 devicePixelRatio: number;
}

class RenderCache {
 private cache = new Map<string, CachedRender>();
 constructor(private readonly maxEntries = 6) {}

 get(key: string) {
  const entry = this.cache.get(key);
  if (!entry) {
   return null;
  }
  this.cache.delete(key);
  this.cache.set(key, entry);
  return entry;
 }

 set(key: string, value: CachedRender) {
  const existing = this.cache.get(key);
  if (existing) {
   existing.bitmap.close();
   this.cache.delete(key);
  }
  this.cache.set(key, value);
  this.enforceCapacity();
 }

 clear() {
  for (const [, entry] of this.cache) {
   entry.bitmap.close();
  }
  this.cache.clear();
 }

 private enforceCapacity() {
  while (this.cache.size > this.maxEntries) {
   const oldestKey = this.cache.keys().next().value;
   if (!oldestKey) {
    break;
   }
   const oldest = this.cache.get(oldestKey);
   if (oldest) {
    oldest.bitmap.close();
   }
   this.cache.delete(oldestKey);
  }
 }
}

const performRenderTask = async (task: RenderTask, signal: AbortSignal, cache?: RenderCache | null) => {
 const { pdfDocument, canvas, plan, applyWatermark, devicePixelRatio } = task;

 const pdfPages = await Promise.all(plan.pagesToRender.map((pageNumber) => pdfDocument.getPage(pageNumber)));
 if (signal.aborted) {
  throw new DOMException('Aborted', 'AbortError');
 }

 const baseViewports = pdfPages.map((page) =>
  page.getViewport({ scale: 1, rotation: plan.rotation })
 );
 const totalBaseWidth = baseViewports.reduce((sum, viewport) => sum + viewport.width, 0);
 const maxBaseHeight = baseViewports.reduce(
  (max, viewport) => Math.max(max, viewport.height),
  0
 );

 const baseScaleRaw = Math.min(
  plan.containerWidth / totalBaseWidth,
  plan.containerHeight / maxBaseHeight
 );
 const baseScale = Math.max(Math.min(baseScaleRaw, 1) * 0.98, 0.1);
 const effectiveScale = baseScale * plan.scale;

 const scaledViewports = pdfPages.map((page) =>
  page.getViewport({ scale: effectiveScale, rotation: plan.rotation })
 );
 const totalWidth = scaledViewports.reduce((sum, viewport) => sum + viewport.width, 0);
 const maxHeight = scaledViewports.reduce(
  (current, viewport) => Math.max(current, viewport.height),
  0
 );

 const context = canvas.getContext('2d');
 if (!context) {
  return;
 }

 const dpr = devicePixelRatio || 1;
 canvas.width = Math.max(1, Math.round(totalWidth * dpr));
 canvas.height = Math.max(1, Math.round(maxHeight * dpr));
 canvas.style.width = `${totalWidth}px`;
 canvas.style.height = `${maxHeight}px`;

 context.setTransform(dpr, 0, 0, dpr, 0, 0);
 context.clearRect(0, 0, totalWidth, maxHeight);

 let offsetX = 0;

 for (let index = 0; index < pdfPages.length; index += 1) {
  if (signal.aborted) {
   throw new DOMException('Aborted', 'AbortError');
  }

  const page = pdfPages[index];
  const viewport = scaledViewports[index];

  context.save();
  context.translate(offsetX, 0);

  const renderTask = page.render({
   canvasContext: context,
   viewport,
  });

  await new Promise<void>((resolve, reject) => {
   const abort = () => {
    renderTask.cancel();
    reject(new DOMException('Aborted', 'AbortError'));
   };

   if (signal.aborted) {
    abort();
    return;
   }

   const listener = () => abort();
   signal.addEventListener('abort', listener);

   renderTask.promise
    .then(() => {
     signal.removeEventListener('abort', listener);
     resolve();
    })
    .catch((error: unknown) => {
     signal.removeEventListener('abort', listener);
     reject(error);
    });
  });

  context.restore();

  applyWatermark(context, { width: viewport.width, height: viewport.height, offsetX }, plan.pagesToRender[index]);

  offsetX += viewport.width;
 }

 if (signal.aborted) {
  throw new DOMException('Aborted', 'AbortError');
 }

 if (cache && typeof createImageBitmap === 'function') {
  try {
   const bitmap = await createImageBitmap(canvas);
   cache.set(task.fingerprint, {
    bitmap,
    width: canvas.width,
    height: canvas.height,
    cssWidth: totalWidth,
    cssHeight: maxHeight,
    devicePixelRatio: dpr,
   });
  } catch (bitmapError) {
   console.warn('Erreur lors de la mise en cache du rendu PDF', bitmapError);
  }
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
 const [pdfReady, setPdfReady] = useState(false);
const [isSpreadMode, setIsSpreadMode] = useState(true);
 const [tocOpen, setTocOpen] = useState(false);
 const [checkingArticles, setCheckingArticles] = useState(false);
 const [articleHotspots, setArticleHotspots] = useState<Record<number, ArticleHotspot[]>>({});
 const [initialArticleId, setInitialArticleId] = useState<string | null>(null);
 const [pendingArticleId, setPendingArticleId] = useState<string | null>(null);
 const [editionInfo, setEditionInfo] = useState<EditionSummary | null>(null);
 const [readerManifest, setReaderManifest] = useState<ReaderManifest | null>(null);
 const [manifestLoading, setManifestLoading] = useState(false);
 const [manifestError, setManifestError] = useState<string | null>(null);
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

const fetchEditionMetadata = useCallback(async (incomingEditionId: string | null, pdfUrl: string) => {
  if (incomingEditionId) {
    setEditionId(incomingEditionId);
    return incomingEditionId;
  }

  const fileName = pdfUrl?.split('/').pop()?.split('?')[0]?.trim();
  if (!fileName) {
    setEditionId(null);
    setEditionInfo(null);
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('editions')
      .select('id, titre, date_publication, date_edition')
      .ilike('pdf_url', `%${fileName}%`)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) {
      setEditionId(null);
      setEditionInfo(null);
      return null;
    }

    const edition = data[0];
    setEditionId(edition.id);
    setEditionInfo({
      id: edition.id,
      titre: edition.titre,
      date_publication: edition.date_publication,
      date_edition: edition.date_edition,
    });
    return edition.id as string;
  } catch (err) {
    console.error('Error fetching edition metadata:', err);
    setEditionId(incomingEditionId ?? null);
    return incomingEditionId;
  }
}, []);

const fetchIpAddress = useCallback(async (): Promise<string | undefined> => {
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { ip?: string };
    return payload.ip || undefined;
  } catch {
    return undefined;
  }
}, []);

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
const pdfDocumentRef = useRef<any | null>(null);
const renderQueueRef = useRef<RenderQueue | null>(null);
const renderCacheRef = useRef<RenderCache | null>(null);
const pendingRenderRequestRef = useRef<{ page: number; rotation: number; scale: number } | null>(null);
const lastRenderFingerprintRef = useRef<string | null>(null);
const hotspotRequestControllerRef = useRef<AbortController | null>(null);
const manifestControllerRef = useRef<AbortController | null>(null);
const touchStartRef = useRef({ x: 0, y: 0, distance: 0, time: 0 });
const scaleRef = useRef(1);
const rotationRef = useRef(0);
const currentPageRef = useRef(1);
const isBrowser = typeof window !== 'undefined';
const [viewportWidth, setViewportWidth] = useState(() =>
 isBrowser ? window.innerWidth : 1024
);
const [viewportHeight, setViewportHeight] = useState(() =>
 isBrowser ? window.innerHeight : 768
);

useEffect(() => {
 if (!isBrowser) return;

 const handleResize = () => {
  setViewportWidth(window.innerWidth);
  setViewportHeight(window.innerHeight);
 };

 handleResize();
 window.addEventListener('resize', handleResize);
 window.addEventListener('orientationchange', handleResize);

 return () => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('orientationchange', handleResize);
 };
}, [isBrowser]);

const isMobile = viewportWidth < 768;
const isTablet = viewportWidth >= 768 && viewportWidth < 1024;

useEffect(() => {
 if (isMobile && isSpreadMode) {
  setIsSpreadMode(false);
 }
 if (!isMobile && !isSpreadMode && viewportWidth >= 1024) {
  setIsSpreadMode(true);
 }
}, [isMobile, isSpreadMode, viewportWidth]);

 const spreadConfig = useMemo(() => {
  const groups: number[] = [];
  const doubleStarts = new Set<number>();

  if (!totalPages || totalPages <= 0) {
   return { groups, doubleStarts };
  }

  if (!isSpreadMode) {
   for (let page = 1; page <= totalPages; page += 1) {
    groups.push(page);
   }
   return { groups, doubleStarts };
  }

  groups.push(1);
  if (totalPages === 1) {
   return { groups, doubleStarts };
  }

  let page = 2;
  while (page <= totalPages) {
   if (page === totalPages) {
    groups.push(page);
    break;
   }

   if (page + 1 === totalPages) {
    groups.push(page);
    doubleStarts.add(page);
    groups.push(totalPages);
    break;
   }

   groups.push(page);
   doubleStarts.add(page);
   page += 2;
  }

  return { groups, doubleStarts };
 }, [isSpreadMode, totalPages]);

 const spreadGroups = spreadConfig.groups;
 const spreadDoubleStarts = spreadConfig.doubleStarts;

const clampPage = useCallback(
 (page: number) => {
  if (!totalPages || totalPages <= 1) return 1;
  let normalized = Math.max(1, Math.min(page, totalPages));

  if (!isSpreadMode || spreadGroups.length === 0) {
   return normalized;
  }

  let target = spreadGroups[0];
  for (const start of spreadGroups) {
   if (start <= normalized) {
    target = start;
   } else {
    break;
   }
  }
  return target;
 },
 [isSpreadMode, spreadGroups, totalPages]
);

const shouldRenderSecondPage = useCallback(
 (pageNumber: number) => isSpreadMode && spreadDoubleStarts.has(pageNumber),
 [spreadDoubleStarts, isSpreadMode]
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

const loadArticleHotspots = useCallback(
 async (targetEditionId: string, signal?: AbortSignal) => {
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

   if (signal?.aborted) {
    return;
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

    if (signal?.aborted) {
     return;
    }

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

   if (signal?.aborted) {
    return;
   }

   const hotspotsMap: Record<number, ArticleHotspot[]> = {};
   const ignoredHotspots: string[] = [];

   articlesData.forEach((article) => {
    if (!article || signal?.aborted) return;

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

   if (signal?.aborted) {
    return;
   }

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
   if ((err as DOMException)?.name === 'AbortError' || signal?.aborted) {
    return;
   }
   console.error('Error loading article hotspots:', err);
   setArticleHotspots({});
   setHasArticles(false);
  } finally {
   if (!signal?.aborted) {
    setCheckingArticles(false);
   }
  }
 },
 []
);

const requestHotspotsForEdition = useCallback(
 (targetEditionId: string | null) => {
  const currentController = hotspotRequestControllerRef.current;
  if (currentController) {
   currentController.abort();
   hotspotRequestControllerRef.current = null;
  }

  if (!targetEditionId) {
   setArticleHotspots({});
   setHasArticles(false);
   setCheckingArticles(false);
   return;
  }

  const controller = new AbortController();
  hotspotRequestControllerRef.current = controller;

  loadArticleHotspots(targetEditionId, controller.signal)
   .then(() => {
    if (!controller.signal.aborted) {
     lastHotspotEditionRef.current = targetEditionId;
    }
   })
   .catch((err) => {
    if (controller.signal.aborted) {
     return;
    }
    console.error('Erreur lors du rafraichissement des hotspots', err);
   })
   .finally(() => {
    if (hotspotRequestControllerRef.current === controller) {
     hotspotRequestControllerRef.current = null;
    }
    if (controller.signal.aborted) {
     setCheckingArticles(false);
    }
   });
 },
 [loadArticleHotspots]
);

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
      lastHotspotEditionRef.current = null;
      if (payload.hasArticles === false) {
       setArticleHotspots({});
       setHasArticles(false);
      } else {
       setHasArticles(true);
      }
      return;
     }

     setArticleHotspots({});
     setHasArticles(payload.hasArticles ?? false);
    })
    .catch((err) => {
     console.error('Error resolving edition metadata (deferred)', err);
     if (payload.hasArticles === false) {
      setArticleHotspots({});
      setHasArticles(false);
     }
    });
 },
 [fetchEditionMetadata]
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
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
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
    const reason = typeof data?.reason === 'string' ? data.reason : '';
    const baseError = data?.error || 'Token invalide';
    setError(reason ? `${baseError} : ${reason}` : baseError);
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
  setCurrentPage(prev => {
   if (!spreadGroups.length) return 1;
   let index = spreadGroups.findIndex(start => start === prev);
   if (index === -1) {
    index = spreadGroups.findIndex(start => start > prev);
    if (index === -1) {
     index = spreadGroups.length;
    }
    index -= 1;
   }
   if (index <= 0) {
    return spreadGroups[0];
   }
   return spreadGroups[index - 1];
  });
}, [setCurrentPage, spreadGroups]);

const goToNextPage = useCallback(() => {
  setCurrentPage(prev => {
   if (!spreadGroups.length) return prev;
   const index = spreadGroups.findIndex(start => start === prev);
   if (index === -1) {
    return prev;
   }
   if (index >= spreadGroups.length - 1) {
    return prev;
   }
   return spreadGroups[index + 1];
  });
}, [setCurrentPage, spreadGroups]);

const currentGroupIndex = useMemo(() => {
 if (!spreadGroups.length) return -1;
 return spreadGroups.findIndex(start => start === currentPage);
}, [currentPage, spreadGroups]);

const currentHasSecondPage = shouldRenderSecondPage(currentPage);

const pageRangeLabel =
 currentHasSecondPage && totalPages
  ? `${currentPage}-${Math.min(totalPages, currentPage + 1)}`
  : `${currentPage}`;

const hasPreviousPage = currentGroupIndex > 0;
const hasNextPage = currentGroupIndex !== -1 && currentGroupIndex < spreadGroups.length - 1;

const previousTargetPage =
 hasPreviousPage && currentGroupIndex > 0 ? spreadGroups[currentGroupIndex - 1] : currentPage;
const nextTargetPage =
 hasNextPage && currentGroupIndex >= 0 ? spreadGroups[currentGroupIndex + 1] : currentPage;

const formatPageLabel = (start: number) => {
 if (shouldRenderSecondPage(start)) {
  return `P ${start}-${Math.min(totalPages, start + 1)}`;
 }
 return `P ${start}`;
};

const spreadSlotCount = currentHasSecondPage ? 2 : 1;

const previousPageLabel = formatPageLabel(previousTargetPage);
const nextPageLabel = formatPageLabel(nextTargetPage);
const hotspotsForCurrentPage = articleHotspots[currentPage] || [];
const hasAnyHotspot = useMemo(
 () => Object.values(articleHotspots).some((list) => Array.isArray(list) && list.length > 0),
 [articleHotspots]
);

const activeSpreadPages = useMemo(() => {
 const pages = new Set<number>();
 pages.add(currentPage);
 if (shouldRenderSecondPage(currentPage)) {
  pages.add(currentPage + 1);
 }
 return pages;
}, [currentPage, shouldRenderSecondPage]);

const hotspotsForSpread = useMemo(() => {
 if (!isSpreadMode) {
  return articleHotspots[currentPage] || [];
 }
 if (!shouldRenderSecondPage(currentPage)) {
  return articleHotspots[currentPage] || [];
 }
 const currentHotspots = (articleHotspots[currentPage] || []).map(h => ({
  ...h,
  pageNumber: currentPage,
  spreadOffset: 0,
 }));
 const nextHotspots =
  shouldRenderSecondPage(currentPage)
   ? (articleHotspots[currentPage + 1] || []).map(h => ({
      ...h,
      pageNumber: currentPage + 1,
      spreadOffset: 1,
     }))
   : [];

 return [...currentHotspots, ...nextHotspots];
}, [articleHotspots, currentPage, isSpreadMode, shouldRenderSecondPage, totalPages]);

const handleSelectPage = useCallback(
 (pageNumber: number) => {
  if (!totalPages) return;
  const normalized = clampPage(pageNumber);
  setCurrentPage(normalized);
  setTocOpen(false);
 },
 [clampPage, setCurrentPage, totalPages]
);

const applyWatermark = useCallback(
 (context: CanvasRenderingContext2D, bounds: { width: number; height: number; offsetX: number }, pageNumber: number) => {
  if (!tokenData?.users?.nom) return;

  context.save();
  context.globalAlpha = 0.08;

  context.translate(bounds.offsetX, 0);

  const fontSize = Math.max(14, Math.min(bounds.width * 0.02, 24));
  context.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  context.fillStyle = '#64748B';
  context.textAlign = 'center';

  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;

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
const applyWatermarkRef = useRef(applyWatermark);
useEffect(() => {
 applyWatermarkRef.current = applyWatermark;
}, [applyWatermark]);
useEffect(() => {
 scaleRef.current = scale;
}, [scale]);

useEffect(() => {
 rotationRef.current = rotation;
}, [rotation]);

const createRenderPlan = useMemo(
 () =>
  (pageNumber: number, renderRotation: number, renderScale: number): RenderPlan | null => {
   if (!totalPages) {
    return null;
   }

   const normalizedPage = clampPage(pageNumber);
   const containerWidth =
    containerRef.current?.clientWidth ?? Math.max(320, viewportWidth - 32);
   const containerHeight = Math.max(
    200,
    viewportHeight - (isMobile ? 220 : isTablet ? 220 : 260)
   );

   const pagesToRender: number[] = [normalizedPage];
   if (isSpreadMode && shouldRenderSecondPage(normalizedPage)) {
    const secondaryPage = Math.min(totalPages, normalizedPage + 1);
    if (!pagesToRender.includes(secondaryPage)) {
     pagesToRender.push(secondaryPage);
    }
   }

   const validPages = pagesToRender.filter((page) => page >= 1 && page <= totalPages);
   if (validPages.length === 0) {
    return null;
   }

   return {
    page: normalizedPage,
    rotation: renderRotation,
    scale: renderScale,
    containerWidth,
    containerHeight,
    pagesToRender: validPages,
   };
  },
 [clampPage, isMobile, isSpreadMode, isTablet, shouldRenderSecondPage, totalPages, viewportHeight, viewportWidth]
);

const ensureRenderQueue = useCallback(() => {
 if (!renderQueueRef.current) {
  if (!renderCacheRef.current) {
   renderCacheRef.current = new RenderCache();
  }
  renderQueueRef.current = new RenderQueue(
   (task, signal) => performRenderTask(task, signal, renderCacheRef.current),
   (completedTask) => {
    lastRenderFingerprintRef.current = completedTask.fingerprint;
    setPdfReady(true);
   },
   (error) => {
    console.error('Error rendering page:', error);
   }
  );
 }
 return renderQueueRef.current!;
}, [setPdfReady]);

const renderPage = useCallback(
 (pageNumber: number, renderRotation: number, renderScale: number) => {
  const pdfDocument = pdfDocumentRef.current;
  const canvas = canvasRef.current;

  if (!pdfDocument || !canvas) {
   pendingRenderRequestRef.current = { page: pageNumber, rotation: renderRotation, scale: renderScale };
   return;
  }

  const plan = createRenderPlan(pageNumber, renderRotation, renderScale);
  if (!plan) {
   pendingRenderRequestRef.current = { page: pageNumber, rotation: renderRotation, scale: renderScale };
   return;
  }

  if (!renderCacheRef.current) {
   renderCacheRef.current = new RenderCache();
  }

  const fingerprint = createPlanFingerprint(plan);
  if (lastRenderFingerprintRef.current === fingerprint) {
   return;
  }

  const currentDpr = window.devicePixelRatio || 1;
  const cachedRender = renderCacheRef.current.get(fingerprint);
  if (cachedRender && Math.abs(cachedRender.devicePixelRatio - currentDpr) < 0.05) {
   const context = canvas.getContext('2d');
   if (context) {
    canvas.width = cachedRender.width;
    canvas.height = cachedRender.height;
    canvas.style.width = `${cachedRender.cssWidth}px`;
    canvas.style.height = `${cachedRender.cssHeight}px`;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, cachedRender.width, cachedRender.height);
    context.drawImage(cachedRender.bitmap, 0, 0);
    lastRenderFingerprintRef.current = fingerprint;
    setPdfReady(true);
    return;
   }
  }

  pendingRenderRequestRef.current = null;

  const queue = ensureRenderQueue();
  queue.enqueue({
   pdfDocument,
   canvas,
   plan,
   fingerprint,
   applyWatermark: applyWatermarkRef.current,
   devicePixelRatio: currentDpr,
  });
 },
 [createRenderPlan, ensureRenderQueue, setPdfReady]
);

useEffect(() => {
 if (!pdfDocumentRef.current || !canvasRef.current) return;
 const pending = pendingRenderRequestRef.current;
 if (!pending) return;
 pendingRenderRequestRef.current = null;
 renderPage(pending.page, pending.rotation, pending.scale);
}, [renderPage]);

useEffect(() => () => {
 renderQueueRef.current?.cancel();
 renderCacheRef.current?.clear();
 hotspotRequestControllerRef.current?.abort();
 manifestControllerRef.current?.abort();
 const doc = pdfDocumentRef.current;
 pdfDocumentRef.current = null;
 if (doc?.destroy) {
  Promise.resolve()
   .then(() => doc.destroy())
   .catch(() => undefined);
 }
}, []);

useEffect(() => {
 if (!pdfUrl) return;

 let cancelled = false;

 const initializePDF = async () => {
  try {
   await ensurePdfJsLib();

   if (pdfDocumentRef.current?.destroy) {
    try {
     await pdfDocumentRef.current.destroy();
    } catch (destroyErr) {
     console.warn('Error while destroying previous PDF instance', destroyErr);
    }
   }

   const loadingTask = window.pdfjsLib.getDocument({
    url: pdfUrl,
    cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/cmaps/`,
    cMapPacked: true,
   });

   const pdf = await loadingTask.promise;
   if (cancelled) {
    await pdf.destroy?.();
    return;
   }

   renderQueueRef.current?.cancel();
   renderCacheRef.current?.clear();
   pdfDocumentRef.current = pdf;
   setTotalPages(pdf.numPages);
   setCurrentPageState(1);
   currentPageRef.current = 1;
   lastRenderFingerprintRef.current = null;
   setPdfReady(false);
   renderPage(1, rotationRef.current, scaleRef.current);
  } catch (err) {
   if (!cancelled) {
    console.error('Error loading PDF:', err);
    let detail = '';
    if (err instanceof Error) {
     detail = err.message;
    } else if (err && typeof err === 'object' && 'message' in err) {
     detail = String((err as any).message);
    } else if (typeof err === 'string') {
     detail = err;
    } else {
     try {
      detail = JSON.stringify(err);
     } catch {
      detail = String(err);
     }
    }

    setError(
     detail
      ? `Erreur lors du chargement du PDF : ${detail}`
      : 'Erreur lors du chargement du PDF'
    );
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
}, [pdfUrl, renderPage]);

useEffect(() => {
 if (!pdfUrl || viewMode !== 'pdf' || loading) return;
 renderPage(currentPage, rotation, scale);
}, [currentPage, loading, pdfUrl, renderPage, rotation, scale, viewMode]);

useEffect(() => {
 if (!editionId) {
  hotspotRequestControllerRef.current?.abort();
  return () => {
   hotspotRequestControllerRef.current?.abort();
  };
 }

 if (!hasArticles) {
  lastHotspotEditionRef.current = null;
  requestHotspotsForEdition(null);
  return () => {
   hotspotRequestControllerRef.current?.abort();
  };
 }

 if (lastHotspotEditionRef.current === editionId && Object.keys(articleHotspots).length > 0) {
  return;
 }

 requestHotspotsForEdition(editionId);

 return () => {
  hotspotRequestControllerRef.current?.abort();
 };
}, [articleHotspots, editionId, hasArticles, requestHotspotsForEdition]);

useEffect(() => {
  if (viewMode === 'article' && editionId && pendingArticleId && pendingArticleId !== initialArticleId) {
    setInitialArticleId(pendingArticleId);
    setPendingArticleId(null);
  }
}, [viewMode, editionId, pendingArticleId, initialArticleId]);

useEffect(() => {
  if (!editionId || !tokenData || !token) {
    manifestControllerRef.current?.abort();
    setReaderManifest(null);
    return;
  }

  manifestControllerRef.current?.abort();
  const controller = new AbortController();
  manifestControllerRef.current = controller;

  setManifestLoading(true);
  setManifestError(null);

  manifestService
    .fetchManifest({ token, editionId })
    .then(async (manifest) => {
      if (controller.signal.aborted) {
        return;
      }
      setReaderManifest(manifest);
      try {
        await preloadImage(manifest.pages[0]?.lowResImageUrl);
      } catch {
        // ignore preload issues
      }
    })
    .catch((err: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
          ? err
          : 'Impossible de charger la liseuse';
      setManifestError(message);
      setReaderManifest(null);
    })
    .finally(() => {
      if (!controller.signal.aborted) {
        setManifestLoading(false);
      }
    });

  return () => {
    controller.abort();
  };
}, [editionId, token, tokenData]);

useEffect(() => {
 if (viewMode !== 'pdf') {
  setTocOpen(false);
 }
}, [viewMode]);


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

const openArticleMode = useCallback(
 (targetArticleId?: string | null) => {
  if (!hasArticles && !hasAnyHotspot) {
   return;
  }

  const resolvedTarget =
   targetArticleId ||
   initialArticleId ||
   firstArticleId ||
   Object.values(articleHotspots).find((list) => list?.length)?.[0]?.id ||
   null;

  if (resolvedTarget) {
   setPendingArticleId(resolvedTarget);
   if (editionId) {
    setInitialArticleId(resolvedTarget);
   }
  }

  setTocOpen(false);
  setViewMode('article');
 },
 [articleHotspots, editionId, firstArticleId, hasAnyHotspot, hasArticles, initialArticleId]
);

const handleHotspotActivate = useCallback(
 (event: SyntheticEvent, hotspot: ArticleHotspot) => {
  event.preventDefault();
  event.stopPropagation();
  openArticleMode(hotspot.id);
 },
 [openArticleMode]
);

 if (!loading && readerManifest && tokenData && editionId) {
  return (
   <AdvancedReader
    manifest={readerManifest}
    token={token}
    sessionId={sessionId}
    onExit={handleExit}
    accessData={{
     userId: tokenData.user_id,
     userName: tokenData.users?.nom ?? initialData?.userName,
     userNumber: tokenData.users?.numero_abonne ?? initialData?.userNumber,
     editionId,
     editionTitle: editionInfo?.titre ?? readerManifest.edition.title,
     pdfId: tokenData.pdf_id,
    }}
   />
 );
}

 if (!loading && manifestLoading) {
  return (
   <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
    <div className="flex flex-col items-center gap-4">
     <div className="h-16 w-16 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
     <p className="text-[#1f3b63] text-sm sm:text-base font-medium">
      Préparation de la liseuse moderne...
     </p>
    </div>
   </div>
  );
 }

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
  'h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] flex items-center justify-center shadow-sm transition hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#1f3b63]';
 const mobileNavButtonClass =
  'flex-1 min-w-[68px] flex flex-col items-center justify-center rounded-2xl border border-[#dfe5f2] bg-white text-[#1f3b63] text-xs font-semibold py-2 px-2 shadow-sm active:scale-[0.97] transition disabled:opacity-40 disabled:pointer-events-none';
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
    {manifestError && (
     <div className="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-[#f8dada] bg-white px-4 py-3 shadow-lg text-sm text-[#b42318]">
       <AlertCircle className="w-4 h-4" />
       <span>
        La liseuse moderne est indisponible pour cette edition ({manifestError}). Affichage du
        mode classique.
       </span>
      </div>
     </div>
    )}
    <header className="fixed top-0 left-0 right-0 z-40 bg-[#ffffff] border-b border-[#dfe5f2] shadow-sm">
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

   <main
    className={`flex-1 w-full relative pt-24 px-4 ${
     isMobile ? 'pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]' : 'pb-20'
    }`}
   >
    <div
     className={`relative mx-auto flex items-center justify-center ${
      isMobile ? 'max-w-full' : 'max-w-5xl'
     }`}
    >
     {!isMobile && hasPreviousPage && (
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
       (isSpreadMode ? hotspotsForSpread : hotspotsForCurrentPage).map((hotspot) => {
        const spreadOffset = (hotspot as { spreadOffset?: number }).spreadOffset ?? 0;
        const pageWidthPercent = 100 / Math.max(1, spreadSlotCount);
        const leftPercent = spreadOffset * pageWidthPercent + clamp01(hotspot.x) * pageWidthPercent;
        const widthPercent = clamp01(hotspot.width) * pageWidthPercent;

        return (
         <button
          key={`${hotspot.id}-${hotspot.ordre}-${spreadOffset}`}
          type="button"
          onClick={(event) => handleHotspotActivate(event, hotspot)}
          onPointerUp={(event) => {
           if (event.pointerType !== 'mouse') {
            handleHotspotActivate(event, hotspot);
           }
          }}
          className="absolute z-30 border border-transparent bg-[#1f3b63]/0 hover:bg-[#1f3b63]/10 focus-visible:bg-[#1f3b63]/12 rounded-lg transition-colors duration-200"
          style={{
           left: `${leftPercent}%`,
           top: `${clamp01(hotspot.y) * 100}%`,
           width: `${widthPercent}%`,
           height: `${clamp01(hotspot.height) * 100}%`,
           touchAction: 'manipulation',
          }}
          title={hotspot.titre}
         >
          <span className="sr-only">{hotspot.titre}</span>
         </button>
        );
       })}
     </div>

      {!isMobile && hasNextPage && (
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

   {isMobile && viewMode === 'pdf' && (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 border-t border-[#dfe5f2] backdrop-blur-md px-4 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] pt-3">
     <div className="max-w-3xl mx-auto flex items-center gap-2">
      <button
       type="button"
       onClick={goToPreviousPage}
       disabled={!hasPreviousPage}
       className={mobileNavButtonClass}
       title="Page precedente"
      >
       <ChevronLeft className="w-4 h-4 mb-1" />
       <span>Precedente</span>
      </button>
      <button
       type="button"
       onClick={() => setTocOpen(prev => !prev)}
       className={`${mobileNavButtonClass} ${tocOpen ? 'bg-[#1f3b63] text-white border-[#1f3b63]' : ''}`}
       title={tocOpen ? 'Masquer la table des matieres' : 'Afficher la table des matieres'}
      >
       <ChevronUp className="w-4 h-4 mb-1 transition-transform duration-150" style={{ transform: tocOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
       <span>Sommaire</span>
      </button>
      {hasArticles && (
       <button
        type="button"
        onClick={() => openArticleMode()}
        disabled={checkingArticles}
        className={mobileNavButtonClass}
        title="Mode article"
       >
        <BookOpen className="w-4 h-4 mb-1" />
        <span>Article</span>
       </button>
      )}
      <button
       type="button"
       onClick={goToNextPage}
       disabled={!hasNextPage}
       className={mobileNavButtonClass}
       title="Page suivante"
      >
       <ChevronRight className="w-4 h-4 mb-1" />
       <span>Suivante</span>
      </button>
     </div>
    </nav>
   )}

   {totalPages > 1 && (
    <>
     {!isMobile && (
      <button
      type="button"
      onClick={() => setTocOpen(prev => !prev)}
      disabled={!pdfReady}
      className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-40 h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] shadow-md flex items-center justify-center transition ${
       pdfReady ? 'hover:shadow-lg' : 'opacity-40 cursor-not-allowed'
      }`}
      title={tocOpen ? 'Masquer la table des matieres' : 'Afficher la table des matieres'}
     >
      {tocOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
      </button>
     )}

     <div
      className={`fixed left-0 right-0 z-30 transform transition-transform duration-300 ${
       tocOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
      }`}
      style={{
       bottom: isMobile
        ? 'calc(env(safe-area-inset-bottom, 0px) + 86px)'
        : '0px',
      }}
     >
      <div
       className={`mx-auto ${isMobile ? 'max-w-full' : 'max-w-6xl'} bg-white/95 border-t border-[#dfe5f2] shadow-lg rounded-t-3xl px-4 py-4 backdrop-blur-md`}
      >
       <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-[#1f3b63] uppercase tracking-wide">
         Table des matieres
        </p>
        <span className="text-[11px] text-[#60719d]">
         {pageRangeLabel} / {totalPages}
        </span>
       </div>
       <div className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: totalPages }, (_, index) => {
         const pageNumber = index + 1;
         const isActive = activeSpreadPages.has(pageNumber);
         return (
          <button
           key={pageNumber}
           type="button"
           onClick={() => handleSelectPage(pageNumber)}
           className={`min-w-[56px] px-3 py-2 rounded-xl border text-xs font-medium transition-all ${
            isActive
             ? 'border-amber-500 bg-amber-500/15 text-amber-600 shadow-sm'
             : 'border-[#dfe5f2] bg-white text-[#1f3b63] hover:border-amber-400 hover:bg-amber-50'
           }`}
          >
           P {pageNumber}
          </button>
         );
        })}
       </div>
      </div>
     </div>
    </>
   )}

  {!isMobile && hasArticles && (
    <button
     type="button"
     onClick={() => openArticleMode()}
     disabled={checkingArticles}
     className="fixed bottom-10 right-6 z-40 h-14 w-14 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] shadow-lg hover:shadow-xl transition disabled:opacity-50"
     title="Mode article"
    >
     <BookOpen className="w-6 h-6 mx-auto" />
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
 }
}
