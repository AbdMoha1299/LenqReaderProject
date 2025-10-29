import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AlertCircle,
  Lock,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  ZoomIn,
  ZoomOut,
  BookOpen,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ensurePromiseWithResolvers } from '../utils/ensurePromiseWithResolvers';
import { ArticleView } from './ArticleView';

interface SecureReaderProps {
  token: string;
}

interface TokenData {
  id: string;
  pdf_id: string;
  user_id: string;
  expires_at: string;
  used: boolean;
  pdfs: {
    titre: string;
    url_fichier: string;
  } | null;
  users: {
    nom: string;
    numero_abonne: string;
  } | null;
}

interface ReaderArticle {
  id: string;
  title: string;
  content: string;
  pageNumber: number;
  subtitle?: string;
  author?: string;
}

export function SecureReader({ token }: SecureReaderProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showWarning, setShowWarning] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [warningType, setWarningType] = useState('');
  const [articles, setArticles] = useState<ReaderArticle[]>([]);
  const [articlesSource, setArticlesSource] = useState<'structured' | 'extracted' | null>(null);
  const [currentArticleIndex, setCurrentArticleIndex] = useState(0);
  const [isArticleViewOpen, setIsArticleViewOpen] = useState(false);
  const [extractingArticles, setExtractingArticles] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const pinchDistanceRef = useRef(0);
  const pdfjsLibRef = useRef<any>(null);
  const pdfDocumentRef = useRef<any>(null);
  const pdfScriptRef = useRef<HTMLScriptElement | null>(null);
  const loadingTaskRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const warningTimeoutRef = useRef<number | null>(null);
  const controlsTimeoutRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const lastSecurityEventRef = useRef<Record<string, number>>({});
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const isMountedRef = useRef(true);
  const currentPageRef = useRef(currentPage);
  const totalPagesRef = useRef(totalPages);
  const structuredFetchRef = useRef(false);
  const tokenDataRef = useRef<TokenData | null>(null);
  const zoomLevelRef = useRef(zoomLevel);
  const pendingPageRef = useRef<number | null>(null);
  const isRenderingRef = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (warningTimeoutRef.current) window.clearTimeout(warningTimeoutRef.current);
      if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
      if (resizeTimeoutRef.current) window.clearTimeout(resizeTimeoutRef.current);
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (err) {
          console.warn('Failed to cancel render task', err);
        }
      }
      if (loadingTaskRef.current?.destroy) {
        try {
          loadingTaskRef.current.destroy();
        } catch (err) {
          console.warn('Failed to destroy loading task', err);
        }
      }
      if (pdfScriptRef.current?.parentNode) {
        pdfScriptRef.current.parentNode.removeChild(pdfScriptRef.current);
      }
    };
  }, []);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    totalPagesRef.current = totalPages;
  }, [totalPages]);

  useEffect(() => {
    tokenDataRef.current = tokenData;
  }, [tokenData]);

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  useEffect(() => {
    sessionIdRef.current = crypto.randomUUID();
  }, [token]);

  const shouldLogSecurityEvent = useCallback((type: string) => {
    const now = Date.now();
    const lastEvent = lastSecurityEventRef.current[type] ?? 0;
    if (now - lastEvent < 4000) {
      return false;
    }
    lastSecurityEventRef.current[type] = now;
    return true;
  }, []);

  const showWarningMessage = useCallback((type: string) => {
    setWarningType(type);
    setShowWarning(true);
    if (warningTimeoutRef.current) {
      window.clearTimeout(warningTimeoutRef.current);
    }
    warningTimeoutRef.current = window.setTimeout(() => {
      setShowWarning(false);
      warningTimeoutRef.current = null;
    }, 5000);
  }, []);

  const loadStructuredArticles = useCallback(
    async (pdfStoragePath: string, pdfId: string) => {
      if (structuredFetchRef.current || !pdfId) {
        return;
      }

      structuredFetchRef.current = true;

      try {
        let editionId: string | null = null;

        const { data: pdfRecord, error: pdfRecordError } = await supabase
          .from('pdfs')
          .select('edition_id')
          .eq('id', pdfId)
          .maybeSingle();

        if (!pdfRecordError && pdfRecord?.edition_id) {
          editionId = pdfRecord.edition_id as string;
        }

        if (!editionId && pdfStoragePath) {
          const { data: editionExact, error: editionExactError } = await supabase
            .from('editions')
            .select('id')
            .eq('pdf_url', pdfStoragePath)
            .maybeSingle();

          if (!editionExactError && editionExact?.id) {
            editionId = editionExact.id;
          } else {
            const fileName = pdfStoragePath.split('/').pop();
            if (fileName) {
              const { data: editionByName, error: editionByNameError } = await supabase
                .from('editions')
                .select('id')
                .ilike('pdf_url', `%${fileName}%`)
                .maybeSingle();

              if (!editionByNameError && editionByName?.id) {
                editionId = editionByName.id;
              }
            }
          }
        }

        if (!editionId) {
          return;
        }

        type RawPage = { id: string; page_number: number | null };
        type RawArticle = {
          id: string;
          titre: string | null;
          sous_titre: string | null;
          contenu_texte: string | null;
          auteur: string | null;
          page_id: string;
          ordre_lecture: number | null;
          valide?: boolean | null;
        };

        const [pagesResponse, articlesResponse] = await Promise.all([
          supabase
            .from('pages')
            .select('id, page_number')
            .eq('edition_id', editionId),
          supabase
            .from('articles')
            .select('id, titre, sous_titre, contenu_texte, auteur, page_id, ordre_lecture, valide')
            .eq('edition_id', editionId)
            .order('ordre_lecture', { ascending: true }),
        ]);

        if (pagesResponse.error) throw pagesResponse.error;
        if (articlesResponse.error) throw articlesResponse.error;

        const pageNumberById = new Map<string, number>();
        (pagesResponse.data as RawPage[] | null)?.forEach((page) => {
          if (page?.id) {
            pageNumberById.set(page.id, page.page_number ?? 0);
          }
        });

        const structured = (articlesResponse.data as RawArticle[] | null)?.filter((article) => {
          if (article?.valide === false) return false;
          return Boolean(article?.contenu_texte);
        }).map<ReaderArticle>((article, index) => ({
          id: article.id,
          title: article.titre?.trim() || `Article ${article.ordre_lecture ?? index + 1}`,
          subtitle: article.sous_titre ?? undefined,
          author: article.auteur ?? undefined,
          content: article.contenu_texte ?? '',
          pageNumber: pageNumberById.get(article.page_id) ?? article.ordre_lecture ?? index + 1,
        })) ?? [];

        if (structured.length) {
          setArticles(structured);
          setArticlesSource('structured');
          setCurrentArticleIndex(0);
        }
      } catch (err) {
        structuredFetchRef.current = false;
        console.error('Error loading structured articles:', err);
      }
    },
    [],
  );

  const logScreenshotAttempt = useCallback(
    async (type: string) => {
      if (!tokenData || !shouldLogSecurityEvent(type)) {
        return;
      }

      try {
        await supabase.from('screenshot_attempts').insert({
          user_id: tokenData.user_id,
          pdf_id: tokenData.pdf_id,
          token_id: tokenData.id,
          detection_type: type,
          page_number: currentPageRef.current,
          device_info: {
            userAgent: navigator.userAgent,
            screen: { width: screen.width, height: screen.height },
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        console.error('Error logging screenshot attempt:', err);
      }
    },
    [tokenData, shouldLogSecurityEvent],
  );

  const preventAndWarn = useCallback(
    (event: Event, type: string) => {
      event.preventDefault();
      logScreenshotAttempt(type);
      showWarningMessage(type);
      return false;
    },
    [logScreenshotAttempt, showWarningMessage],
  );

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen toggle failed:', err);
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const loadPdfJs = useCallback(async () => {
    ensurePromiseWithResolvers();
    if (pdfjsLibRef.current) {
      return pdfjsLibRef.current;
    }

    if (typeof window !== 'undefined' && window.pdfjsLib) {
      pdfjsLibRef.current = window.pdfjsLib;
    } else {
      const existingScript = document.querySelector<HTMLScriptElement>(
        'script[data-secure-reader-pdfjs="true"], script[data-secure-reader="pdfjs"]',
      );

      await new Promise<void>((resolve, reject) => {
        if (existingScript) {
          pdfScriptRef.current = existingScript;

          if (existingScript.dataset.secureReaderLoaded === 'true') {
            resolve();
            return;
          }

          existingScript.addEventListener('load', () => resolve(), { once: true });
          existingScript.addEventListener('error', () => reject(new Error('Impossible de charger PDF.js')), {
            once: true,
          });
          return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.js';
        script.async = true;
        script.dataset.secureReaderPdfjs = 'true';
        script.addEventListener(
          'load',
          () => {
            script.dataset.secureReaderLoaded = 'true';
            resolve();
          },
          { once: true },
        );
        script.addEventListener(
          'error',
          () => reject(new Error('Impossible de charger PDF.js')),
          { once: true },
        );
        document.head.appendChild(script);
        pdfScriptRef.current = script;
      });

      pdfjsLibRef.current = window.pdfjsLib;
    }

    if (!pdfjsLibRef.current) {
      throw new Error('PDF.js indisponible');
    }

    pdfjsLibRef.current.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js';

    return pdfjsLibRef.current;
  }, []);

    const drawWatermark = useCallback(
    (context: CanvasRenderingContext2D, pageNum: number, viewport: { width: number; height: number }) => {
      const activeToken = tokenDataRef.current;
      if (!activeToken) return;

      context.save();
      const userName = activeToken.users?.nom?.toUpperCase() || 'LECTEUR';
      const abonNumber = activeToken.users?.numero_abonne || 'N/A';
      const sessionPrefix = sessionIdRef.current.substring(0, 8).toUpperCase();
      const timestamp = new Date().toLocaleString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const fontSize = Math.max(14, Math.min(viewport.width * 0.03, 28));
      context.globalAlpha = 0.12;
      context.fillStyle = '#1f2937';
      context.textAlign = 'center';
      context.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

      context.translate(viewport.width / 2, viewport.height / 2);
      context.rotate(-Math.PI / 8);

      context.fillText(userName, 0, -fontSize * 1.5);
      context.fillText(`Abonne ${abonNumber}`, 0, 0);
      context.fillText(timestamp, 0, fontSize * 1.5);
      context.fillText(`Session ${sessionPrefix} - P${pageNum}`, 0, fontSize * 3);
      context.restore();
    },
    [],
  );
;

const renderPageInternal = useCallback(
  async (pageNum: number) => {
    const pdf = pdfDocumentRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const activeToken = tokenDataRef.current;
    if (!pdf || !canvas || !activeToken) return;

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch (err) {
        console.warn('Unable to cancel previous render task', err);
      }
      renderTaskRef.current = null;
    }

    const page = await pdf.getPage(pageNum);
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const bounds = container?.getBoundingClientRect();
    const availableWidth = Math.max(320, (bounds?.width ?? window.innerWidth) - 48);
    const availableHeight = Math.max(360, window.innerHeight - 240);

    const baseViewport = page.getViewport({ scale: 1 });
    const scaleX = availableWidth / baseViewport.width;
    const scaleY = availableHeight / baseViewport.height;
    const fitScale = Math.min(scaleX, scaleY);
    const zoom = zoomLevelRef.current;
    const effectiveScale = Math.max(fitScale * zoom, 0.5);

    const viewport = page.getViewport({ scale: effectiveScale });
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.style.maxWidth = '100%';
    canvas.style.objectFit = 'contain';

    context.save();
    try {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);

      const renderTask = page.render({
        canvasContext: context,
        viewport,
      });
      renderTaskRef.current = renderTask;
      await renderTask.promise;

      drawWatermark(context, pageNum, viewport);
    } finally {
      context.restore();
      renderTaskRef.current = null;
    }
  },
  [drawWatermark],
);

const processRenderQueue = useCallback(async () => {
  if (isRenderingRef.current) {
    return;
  }

  const nextPage = pendingPageRef.current;
  if (nextPage == null) {
    return;
  }

  isRenderingRef.current = true;
  pendingPageRef.current = null;

  try {
    await renderPageInternal(nextPage);
  } catch (err) {
    console.error('Error processing render queue:', err);
  } finally {
    isRenderingRef.current = false;
  }

  if (pendingPageRef.current != null) {
    await processRenderQueue();
  }
}, [renderPageInternal]);

const renderPage = useCallback(
  (pageNum: number) => {
    pendingPageRef.current = pageNum;
    void processRenderQueue();
  },
  [processRenderQueue],
);

const renderPDF = useCallback(async () => {
  if (!pdfUrl) return;

  try {
    if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (err) {
          console.warn('Failed to cancel previous render task', err);
        }
        renderTaskRef.current = null;
      }

      if (loadingTaskRef.current?.destroy) {
        try {
          await loadingTaskRef.current.destroy();
        } catch (err) {
          console.warn('Failed to destroy previous loading task', err);
        }
        loadingTaskRef.current = null;
      }

      if (pdfDocumentRef.current?.destroy) {
        try {
          await pdfDocumentRef.current.destroy();
        } catch (err) {
          console.warn('Failed to destroy previous PDF document', err);
        }
      }
      pdfDocumentRef.current = null;
      isRenderingRef.current = false;
      pendingPageRef.current = null;

      const pdfjsLib = await loadPdfJs();
      const loadingTask = pdfjsLib.getDocument({
        url: pdfUrl,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/cmaps/',
        cMapPacked: true,
        disableAutoFetch: true,
        disableStream: false,
        isEvalSupported: false,
      });

      loadingTaskRef.current = loadingTask;

      const pdf = await loadingTask.promise;
      pdfDocumentRef.current = pdf;

      if (!isMountedRef.current) {
        return;
      }

      pendingPageRef.current = 1;
      currentPageRef.current = 1;
      setTotalPages(pdf.numPages);
      setCurrentPage(1);
      await processRenderQueue();
    } catch (err) {
      console.error('Error loading PDF:', err);
      if (isMountedRef.current) {
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

        const message = detail
          ? `Erreur lors du chargement du PDF : ${detail}`
          : 'Erreur lors du chargement du PDF';
        setError(message);
      }
    }
  }, [loadPdfJs, pdfUrl, processRenderQueue]);

  const extractTextFromPage = useCallback(async (pageNum: number) => {
    const pdf = pdfDocumentRef.current;
    if (!pdf) return [];

    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      const extractedArticles: ReaderArticle[] = [];
      let buffer = '';
      let articleCount = 0;

      for (const item of textContent.items) {
        if ('str' in item) {
          const str = item.str.trim();
          if (!str) continue;
          buffer += str + ' ';

          const isParagraphBreak = /[.!?]$/.test(str) && buffer.length > 220;
          if (isParagraphBreak) {
            articleCount += 1;
            const title = buffer.substring(0, 80).trim();
            extractedArticles.push({
              id: 'article-' + pageNum + '-' + articleCount,
              title: title + (title.length >= 80 ? '...' : ''),
              content: buffer.trim(),
              pageNumber: pageNum,
              subtitle: undefined,
              author: undefined,
            });
            buffer = '';
          }
        }
      }

      if (buffer.length > 60) {
        articleCount += 1;
        const title = buffer.substring(0, 80).trim();
        extractedArticles.push({
          id: 'article-' + pageNum + '-' + articleCount,
          title: title + (title.length >= 80 ? '...' : ''),
          content: buffer.trim(),
          pageNumber: pageNum,
          subtitle: undefined,
          author: undefined,
        });
      }

      return extractedArticles;
    } catch (err) {
      console.error('Error extracting text:', err);
      return [];
    }
  }, []);

  const handleExtractArticles = useCallback(async () => {
    if (extractingArticles) return;

    if (articles.length > 0) {
      setCurrentArticleIndex(0);
      setIsArticleViewOpen(true);
      return;
    }

    setExtractingArticles(true);
    try {
      const extracted = await extractTextFromPage(currentPageRef.current);
      setArticles(extracted);
      if (extracted.length > 0) {
        setArticlesSource('extracted');
      }
      setCurrentArticleIndex(0);
      setIsArticleViewOpen(extracted.length > 0);
    } finally {
      setExtractingArticles(false);
    }
  }, [articles.length, extractingArticles, extractTextFromPage]);

  const openStructuredArticle = useCallback(
    (articleId: string) => {
      const index = articles.findIndex((article) => article.id === articleId);
      if (index >= 0) {
        setCurrentArticleIndex(index);
        setIsArticleViewOpen(true);
      }
    },
    [articles],
  );

  const structuredArticlesForPage = useMemo(() => {
    if (articlesSource !== 'structured') {
      return [];
    }

    return articles.filter((article) => article.pageNumber === currentPage);
  }, [articles, articlesSource, currentPage]);

  const resolveSecurePdfUrl = useCallback(async (rawPath: string | null | undefined) => {
    const storagePath = rawPath?.trim?.() ?? '';
    if (!storagePath) {
      throw new Error('Document inaccessible');
    }

    if (/^https?:\/\//i.test(storagePath)) {
      return storagePath;
    }

    const trySignedUrl = async () => {
      const { data: signedData, error: signedError } = await supabase.storage
        .from('secure-pdfs')
        .createSignedUrl(storagePath, 60 * 60);
      if (!signedError && signedData?.signedUrl) {
        return signedData.signedUrl;
      }
      return null;
    };

    const tryPublicUrl = () => {
      const {
        data: { publicUrl },
      } = supabase.storage.from('secure-pdfs').getPublicUrl(storagePath);
      return publicUrl || null;
    };

    const signedUrl = await trySignedUrl();
    if (signedUrl) return signedUrl;

    const fallbackUrl = tryPublicUrl();
    if (fallbackUrl) return fallbackUrl;

    throw new Error('Impossible de g�n�rer un acc�s s�curis� au PDF');
  }, []);

  const validateToken = useCallback(async () => {
    if (!token) {
      setError('Lien invalide');
      setLoading(false);
      return;
    }

  setLoading(true);
  setError('');
  structuredFetchRef.current = false;
  setArticles([]);
  setArticlesSource(null);
  setCurrentArticleIndex(0);
  setIsArticleViewOpen(false);

  try {
      const { data, error: tokenError } = await supabase
        .from('tokens')
        .select(
          `
            *,
            pdfs (titre, url_fichier),
            users (nom, numero_abonne)
          `,
        )
        .eq('token', token)
        .maybeSingle();

      if (tokenError) throw tokenError;
      if (!data) throw new Error('Lien invalide ou expiré');

      if (new Date(data.expires_at) < new Date()) {
        throw new Error('Ce lien a expiré');
      }

      if (!data.pdfs?.url_fichier) {
        throw new Error('Document inaccessible');
      }

      const resolvedPdfUrl = await resolveSecurePdfUrl(data.pdfs.url_fichier);

      if (!isMountedRef.current) return;

      setTokenData(data as TokenData);
      setPdfUrl(resolvedPdfUrl);
      loadStructuredArticles(data.pdfs?.url_fichier ?? '', data.pdf_id);

      await supabase.from('logs').insert({
        pdf_id: data.pdf_id,
        user_id: data.user_id,
        ip: 'hidden',
        user_agent: navigator.userAgent,
        session_id: sessionIdRef.current,
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Erreur de validation');
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [token, loadStructuredArticles, resolveSecurePdfUrl]);

  useEffect(() => {
    ensurePromiseWithResolvers();
    validateToken();
  }, [validateToken]);

  useEffect(() => {
    if (!pdfUrl || !tokenData) return;
    renderPDF();
  }, [pdfUrl, tokenData, renderPDF]);

  useEffect(() => {
    if (!pdfDocumentRef.current) return;
    renderPage(currentPage);
  }, [currentPage, renderPage]);

  useEffect(() => {
    if (!pdfDocumentRef.current) return;
    renderPage(currentPageRef.current);
  }, [zoomLevel, renderPage]);

  useEffect(() => {
    const handleResize = () => {
      if (resizeTimeoutRef.current) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(() => {
        renderPage(currentPageRef.current);
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeoutRef.current) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
    };
  }, [renderPage]);

  const handlePointerActivity = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      window.clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = window.setTimeout(() => {
      setShowControls(false);
      controlsTimeoutRef.current = null;
    }, 3000);
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      handlePointerActivity();
      if (e.touches.length === 1) {
        touchStartXRef.current = e.touches[0].clientX;
        touchStartYRef.current = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchDistanceRef.current = Math.sqrt(dx * dx + dy * dy);
      }
    },
    [handlePointerActivity],
  );

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchDistanceRef.current > 0) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDistance = Math.sqrt(dx * dx + dy * dy);
      const scale = newDistance / pinchDistanceRef.current;

      if (scale > 1.1) {
        setZoomLevel((prev) => Math.min(prev + 0.1, 3));
        pinchDistanceRef.current = newDistance;
      } else if (scale < 0.9) {
        setZoomLevel((prev) => Math.max(prev - 0.1, 0.5));
        pinchDistanceRef.current = newDistance;
      }
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && touchStartXRef.current !== 0) {
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartXRef.current;
      const deltaY = Math.abs(touchEndY - touchStartYRef.current);

      if (Math.abs(deltaX) > 50 && deltaY < 100) {
        if (deltaX > 0) {
          setCurrentPage((prev) => Math.max(1, prev - 1));
        } else if (deltaX < 0) {
          setCurrentPage((prev) => Math.min(totalPagesRef.current, prev + 1));
        }
      }
    }

    touchStartXRef.current = 0;
    touchStartYRef.current = 0;
    pinchDistanceRef.current = 0;
  }, []);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && ['p', 's', 'c'].includes(key)) {
        preventAndWarn(event, key === 'p' ? 'print' : key === 's' ? 'save' : 'copy');
        return;
      }

      if (event.key === 'PrintScreen') {
        preventAndWarn(event, 'screenshot');
        return;
      }

      if (key === 'arrowleft') {
        event.preventDefault();
        setCurrentPage((prev) => Math.max(1, prev - 1));
        handlePointerActivity();
      } else if (key === 'arrowright') {
        event.preventDefault();
        setCurrentPage((prev) => Math.min(totalPagesRef.current, prev + 1));
        handlePointerActivity();
      } else if (key === 'f') {
        event.preventDefault();
        toggleFullscreen();
      }
    };

    const handleContextMenu = (event: MouseEvent) => preventAndWarn(event, 'rightclick');
    const handleCopy = (event: ClipboardEvent | Event) => preventAndWarn(event, 'copy');

    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCopy);

    const devtoolsInterval = window.setInterval(() => {
      const widthThreshold = window.outerWidth - window.innerWidth > 160;
      const heightThreshold = window.outerHeight - window.innerHeight > 160;
      if (widthThreshold || heightThreshold) {
        logScreenshotAttempt('devtools');
        showWarningMessage('devtools');
      }
    }, 1500);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCopy);
      window.clearInterval(devtoolsInterval);
    };
  }, [handlePointerActivity, logScreenshotAttempt, preventAndWarn, showWarningMessage, toggleFullscreen]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-16 w-16 border-4 border-amber-500/20 border-t-amber-500 mb-6"></div>
          <p className="text-gray-300 text-lg font-medium">Validation du lien...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900 border border-red-700 rounded-2xl p-10 shadow-2xl">
          <AlertCircle className="w-20 h-20 text-red-500 mx-auto mb-6" />
          <h2 className="text-3xl font-bold text-white text-center mb-3">Accès refusé</h2>
          <p className="text-gray-300 text-center text-lg">{error}</p>
        </div>
      </div>
    );
  }

  const getWarningMessage = (type: string) => {
    switch (type) {
      case 'screenshot':
        return "Capture d'écran détectée ! Cette action est interdite et a été enregistrée.";
      case 'print':
        return "Impression interdite ! Cette action est interdite et a été enregistrée.";
      case 'copy':
        return 'Copie interdite ! Cette action est interdite et a été enregistrée.';
      case 'save':
        return 'Enregistrement interdit !';
      case 'rightclick':
        return 'Clic droit désactivé pour protéger le contenu.';
      case 'devtools':
        return 'Outils de développement détectés ! Cette action est suspecte.';
      default:
        return 'Action non autorisée détectée !';
    }
  };

  return (
    <div
      className="min-h-screen select-none bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950"
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseMove={handlePointerActivity}
    >
      {showWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm animate-pulse">
          <div className="bg-gradient-to-br from-red-900 to-red-950 border-2 border-red-500 rounded-2xl p-8 sm:p-10 max-w-md mx-4 text-center shadow-2xl">
            <AlertCircle className="w-16 sm:w-20 h-16 sm:h-20 text-red-200 mx-auto mb-4 sm:mb-6 animate-bounce" />
            <h3 className="text-2xl sm:text-3xl font-bold text-white mb-2 sm:mb-3">AVERTISSEMENT</h3>
            <p className="text-red-100 text-base sm:text-lg mb-3 sm:mb-4">{getWarningMessage(warningType)}</p>
            <p className="text-red-200 text-xs sm:text-sm">
              Toute tentative de partage non autorisé peut entraîner la suspension de votre compte.
            </p>
          </div>
        </div>
      )}

      <div
        className={`fixed top-0 left-0 right-0 z-40 border-b bg-slate-900/98 border-slate-800 backdrop-blur-lg shadow-xl transition-all duration-300 ${
          showControls ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'
        }`}
      >
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-3 mb-3 sm:mb-4">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              <div className="p-1.5 sm:p-2.5 bg-gradient-to-br from-amber-500 to-orange-500 rounded-lg sm:rounded-xl shadow-lg flex-shrink-0">
                <Lock className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-white font-semibold text-sm sm:text-base truncate">
                  {tokenData?.pdfs?.titre ?? 'Edition protégée'}
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm truncate">
                  {tokenData?.users?.nom ?? 'Lecteur'} • Page {currentPage}/{totalPages || '...'}
                </p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
                Lecture sécurisée activée
              </div>
              <div className="px-3 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium">
                Session {sessionIdRef.current.substring(0, 8).toUpperCase()}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-gray-300 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline text-sm font-medium">Page précédente</span>
              </button>
              <button
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-gray-300 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <span className="hidden sm:inline text-sm font-medium">Page suivante</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden sm:flex flex-col text-right leading-tight">
                <span className="text-gray-400 text-xs">Numéro d'abonné</span>
                <span className="text-white text-sm font-semibold">
                  {tokenData?.users?.numero_abonne ?? 'N/A'}
                </span>
              </div>
              <div className="hidden sm:block h-9 w-px bg-slate-700" />
              <div className="flex items-center gap-1 bg-slate-800/50 rounded-lg px-1 py-1">
                <button
                  onClick={() => setZoomLevel((prev) => Math.max(prev - 0.2, 0.5))}
                  disabled={zoomLevel <= 0.5}
                  className="p-1.5 sm:p-2 text-white rounded-lg hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  title="Zoom arrière"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>

                <span className="text-white text-xs sm:text-sm font-semibold px-2 min-w-[3rem] text-center">
                  {Math.round(zoomLevel * 100)}%
                </span>

                <button
                  onClick={() => setZoomLevel((prev) => Math.min(prev + 0.2, 2.5))}
                  disabled={zoomLevel >= 2.5}
                  className="p-1.5 sm:p-2 text-white rounded-lg hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  title="Zoom avant"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              </div>

              <button
                onClick={toggleFullscreen}
                className="p-1.5 sm:p-2 text-gray-400 hover:text-white hover:bg-slate-700 rounded-lg transition-all bg-slate-800/50"
                title={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>

              <button
                onClick={handleExtractArticles}
                disabled={extractingArticles}
                className="p-1.5 sm:p-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-lg transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title={articlesSource === 'structured' ? 'Ouvrir les articles' : 'Extraire les articles'}
                aria-label={articlesSource === 'structured' ? 'Ouvrir les articles' : 'Extraire les articles'}
              >
                <BookOpen className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {structuredArticlesForPage.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 sm:pt-32 pb-6">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl shadow-2xl p-4 sm:p-6">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-white text-lg sm:text-xl font-semibold">Articles de cette page</h2>
                <p className="text-slate-400 text-sm">
                  Accès direct aux contenus enrichis : titres, sous-titres et auteurs issus de la rédaction.
                </p>
              </div>
              <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-3 py-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Contenu structuré
              </div>
            </div>
            <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
              {structuredArticlesForPage.map((article) => (
                <button
                  key={article.id}
                  onClick={() => openStructuredArticle(article.id)}
                  className="text-left bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-amber-500/40 transition-colors rounded-xl p-4 sm:p-5 group shadow-lg shadow-black/20"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 text-amber-300 flex-shrink-0">
                      <BookOpen className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs uppercase tracking-wide text-slate-400 mb-1">
                        Page {article.pageNumber}
                      </p>
                      <h3 className="text-white font-semibold text-base sm:text-lg mb-1 line-clamp-2 group-hover:text-amber-400 transition-colors">
                        {article.title}
                      </h3>
                      {article.subtitle && (
                        <p className="text-sm text-slate-300 mb-1 line-clamp-2">{article.subtitle}</p>
                      )}
                      {article.author && (
                        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                          {article.author}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-amber-300 font-medium">
                    <span>Lire l'article</span>
                    <ChevronRight className="w-3 h-3" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <ArticleView
        articles={articles}
        currentArticleIndex={currentArticleIndex}
        isOpen={isArticleViewOpen}
        onClose={() => setIsArticleViewOpen(false)}
        onNavigate={(index) => setCurrentArticleIndex(index)}
      />

      <div className="flex items-center justify-center px-4 sm:px-6 lg:px-8 py-24 sm:py-28" style={{ minHeight: '100vh' }}>
        <div className="relative w-full flex items-center justify-center">
          <canvas
            ref={canvasRef}
            className="shadow-2xl transition-all duration-300 rounded-lg mx-auto"
            style={{
              userSelect: 'none',
              pointerEvents: 'none',
              maxWidth: '100%',
              height: 'auto',
              display: 'block',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(100, 116, 139, 0.3)',
            }}
          />
          <div
            className={`absolute -inset-4 bg-gradient-to-r from-amber-500/8 to-orange-500/8 rounded-2xl -z-10 blur-2xl transition-opacity duration-300 ${
              showControls ? 'opacity-100' : 'opacity-0'
            }`}
          ></div>
        </div>
      </div>

      <style>{`
        @media print {
          * {
            display: none !important;
          }
        }

        * {
          user-select: none !important;
          -webkit-user-select: none !important;
          -moz-user-select: none !important;
          -ms-user-select: none !important;
        }

        canvas {
          pointer-events: none !important;
          -webkit-touch-callout: none !important;
        }

        ::-webkit-scrollbar {
          width: 8px;
        }

        ::-webkit-scrollbar-track {
          background: #0f172a;
        }

        ::-webkit-scrollbar-thumb {
          background: linear-gradient(to bottom, #f59e0b, #ea580c);
          border-radius: 6px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(to bottom, #d97706, #c2410c);
        }
      `}</style>
    </div>
  );
}

declare global {
  interface Window {
    pdfjsLib: any;
  }
}




