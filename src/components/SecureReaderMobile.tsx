import { useState, useEffect, useRef } from 'react';
import { AlertCircle, Lock, ChevronLeft, ChevronRight, Maximize, Minimize, BookOpen } from 'lucide-react';
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
  const [warningType, setWarningType] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [articles, setArticles] = useState<Array<{id: string; title: string; content: string; pageNumber: number}>>([]);
  const [currentArticleIndex, setCurrentArticleIndex] = useState(0);
  const [isArticleViewOpen, setIsArticleViewOpen] = useState(false);
  const [extractingArticles, setExtractingArticles] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);
  const pinchDistance = useRef<number>(0);

  useEffect(() => {
    ensurePromiseWithResolvers();
    validateToken();
    const newSessionId = crypto.randomUUID();
    setSessionId(newSessionId);

    const preventActions = (e: Event, type: string) => {
      e.preventDefault();
      logScreenshotAttempt(type);
      showWarningMessage(type);
      return false;
    };

    const preventKeys = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && (e.key === 'p' || e.key === 's' || e.key === 'c')) ||
        (e.metaKey && (e.key === 'p' || e.key === 's' || e.key === 'c')) ||
        e.key === 'PrintScreen'
      ) {
        e.preventDefault();
        logScreenshotAttempt(e.key === 'PrintScreen' ? 'screenshot' : e.key === 'p' ? 'print' : 'copy');
        showWarningMessage(e.key === 'PrintScreen' ? 'screenshot' : e.key === 'p' ? 'print' : 'copy');
        return false;
      }

      if (e.key === 'ArrowLeft' && currentPage > 1) {
        setCurrentPage(p => p - 1);
      } else if (e.key === 'ArrowRight' && currentPage < totalPages) {
        setCurrentPage(p => p + 1);
      }
    };

    const handleContextMenu = (e: Event) => preventActions(e, 'rightclick');
    const handleCopy = (e: Event) => preventActions(e, 'copy');

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', preventKeys);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCopy);

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', preventKeys);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCopy);
    };
  }, [token]);

  useEffect(() => {
    if (pdfUrl && tokenData) {
      if (!window.pdfjsLib) {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.js';
        script.onload = () => {
          if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js';
            loadPDF();
          }
        };
        document.head.appendChild(script);
      } else {
        loadPDF();
      }
    }
  }, [pdfUrl, tokenData]);

  useEffect(() => {
    if (tokenData && totalPages > 0) {
      renderPage(currentPage);
    }
  }, [currentPage, tokenData, totalPages, zoomLevel]);


  const logScreenshotAttempt = async (type: string) => {
    if (!tokenData) return;

    try {
      await supabase.from('screenshot_attempts').insert({
        user_id: tokenData.user_id,
        pdf_id: tokenData.pdf_id,
        token_id: tokenData.id,
        detection_type: type,
        page_number: currentPage,
        device_info: {
          userAgent: navigator.userAgent,
          screen: { width: screen.width, height: screen.height },
          timestamp: new Date().toISOString()
        }
      });
    } catch (err) {
      console.error('Error logging screenshot attempt:', err);
    }
  };

  const showWarningMessage = (type: string) => {
    setWarningType(type);
    setShowWarning(true);
    setTimeout(() => setShowWarning(false), 5000);
  };

  const validateToken = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select(`
          *,
          pdfs (titre, url_fichier),
          users (nom, numero_abonne)
        `)
        .eq('token', token)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Lien invalide ou expiré');

      if (new Date(data.expires_at) < new Date()) {
        throw new Error('Ce lien a expiré');
      }

      setTokenData(data as TokenData);

      const { data: { publicUrl } } = supabase.storage
        .from('secure-pdfs')
        .getPublicUrl(data.pdfs?.url_fichier || '');

      setPdfUrl(publicUrl);

      await supabase.from('logs').insert({
        pdf_id: data.pdf_id,
        user_id: data.user_id,
        ip: 'hidden',
        user_agent: navigator.userAgent,
        session_id: sessionId
      });

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de validation');
    } finally {
      setLoading(false);
    }
  };

  const loadPDF = async () => {
    renderPDF();
  };

  const renderPDF = async () => {
    if (!window.pdfjsLib || !pdfUrl) return;

    try {
      const loadingTask = window.pdfjsLib.getDocument({
        url: pdfUrl,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/cmaps/',
        cMapPacked: true,
        disableAutoFetch: true,
        disableStream: false,
        isEvalSupported: false,
      });

      const pdf = await loadingTask.promise;
      setTotalPages(pdf.numPages);
      (window as any).pdfDocument = pdf;
      renderPage(1);
    } catch (err) {
      console.error('Error loading PDF:', err);
      setError('Erreur lors du chargement du PDF');
    }
  };

  const extractTextFromPage = async (pageNum: number) => {
    const pdf = (window as any).pdfDocument;
    if (!pdf) return [];

    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      const articles: Array<{id: string; title: string; content: string; pageNumber: number}> = [];
      let currentText = '';
      let articleCount = 0;

      for (const item of textContent.items) {
        if ('str' in item) {
          currentText += item.str + ' ';

          if (currentText.length > 200 && (item.str.endsWith('.') || item.str.endsWith('!') || item.str.endsWith('?'))) {
            articleCount++;
            const title = currentText.substring(0, 60).trim() + '...';
            articles.push({
              id: `article-${pageNum}-${articleCount}`,
              title: title,
              content: currentText.trim(),
              pageNumber: pageNum
            });
            currentText = '';
          }
        }
      }

      if (currentText.length > 50) {
        articleCount++;
        const title = currentText.substring(0, 60).trim() + '...';
        articles.push({
          id: `article-${pageNum}-${articleCount}`,
          title: title,
          content: currentText.trim(),
          pageNumber: pageNum
        });
      }

      return articles;
    } catch (err) {
      console.error('Error extracting text:', err);
      return [];
    }
  };

  const handleExtractArticles = async () => {
    setExtractingArticles(true);
    const extractedArticles = await extractTextFromPage(currentPage);
    setArticles(extractedArticles);
    setCurrentArticleIndex(0);
    if (extractedArticles.length > 0) {
      setIsArticleViewOpen(true);
    }
    setExtractingArticles(false);
  };

  const renderPage = async (pageNum: number) => {
    const pdf = (window as any).pdfDocument;
    if (!pdf || !canvasRef.current || !tokenData) return;

    try {
      const page = await pdf.getPage(pageNum);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      if (!context) return;

      const containerWidth = window.innerWidth - 24;
      const containerHeight = window.innerHeight - 180;
      const viewport = page.getViewport({ scale: 1 });

      const scaleX = containerWidth / viewport.width;
      const scaleY = containerHeight / viewport.height;
      const baseScale = Math.min(scaleX, scaleY);
      const scale = baseScale * zoomLevel * (window.devicePixelRatio || 1);

      const scaledViewport = page.getViewport({ scale });

      canvas.height = scaledViewport.height;
      canvas.width = scaledViewport.width;
      canvas.style.width = `${scaledViewport.width / (window.devicePixelRatio || 1)}px`;
      canvas.style.height = `${scaledViewport.height / (window.devicePixelRatio || 1)}px`;
      canvas.style.maxWidth = '100%';
      canvas.style.objectFit = 'contain';

      await page.render({
        canvasContext: context,
        viewport: scaledViewport
      }).promise;

      if (tokenData.users?.nom) {
        const sessionHash = sessionId.substring(0, 8).toUpperCase();
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = now.toLocaleDateString('fr-FR');
        const milliseconds = now.getMilliseconds();

        const watermarkCount = 5 + Math.floor(Math.random() * 3);
        for (let i = 0; i < watermarkCount; i++) {
          context.save();

          const opacity = 0.06 + Math.random() * 0.04;
          context.globalAlpha = opacity;

          const fontSize = Math.max(10, Math.min(canvas.width * 0.016, 18));
          context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          context.fillStyle = '#64748B';
          context.textAlign = 'center';

          const x = (Math.random() * 0.7 + 0.15) * canvas.width;
          const y = (Math.random() * 0.7 + 0.15) * canvas.height;

          context.translate(x, y);
          const rotationAngle = (Math.random() - 0.5) * Math.PI / 6;
          context.rotate(rotationAngle);

          context.fillText(tokenData.users.nom.toUpperCase(), 0, 0);
          context.fillText(`${tokenData.users.numero_abonne || ''} • ${dateStr}`, 0, fontSize * 1.5);
          context.fillText(`${timeStr} • P${pageNum}-${sessionHash.slice(-4)}`, 0, fontSize * 3);

          context.restore();
        }

        context.save();
        context.globalAlpha = 0.09;
        const centerFontSize = Math.max(12, Math.min(canvas.width * 0.020, 22));
        context.font = `700 ${centerFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        context.fillStyle = '#94A3B8';
        context.textAlign = 'center';

        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(-Math.PI / 7);

        context.fillText(tokenData.users.nom.toUpperCase(), 0, -centerFontSize * 0.7);
        context.fillText(`DOCUMENT PROTÉGÉ`, 0, centerFontSize * 0.5);
        context.fillText(`${timeStr} • PAGE ${pageNum}`, 0, centerFontSize * 1.8);
        context.fillText(`${sessionHash}-${milliseconds}`, 0, centerFontSize * 2.9);

        context.restore();
      }
    } catch (err) {
      console.error('Error rendering page:', err);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchDistance.current = Math.sqrt(dx * dx + dy * dy);
    } else if (e.touches.length === 1) {
      touchStartX.current = e.touches[0].clientX;
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchDistance.current > 0) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDistance = Math.sqrt(dx * dx + dy * dy);
      const scale = newDistance / pinchDistance.current;

      if (Math.abs(scale - 1) > 0.05) {
        if (scale > 1) {
          setZoomLevel(prev => Math.min(prev + 0.05, 2.5));
        } else {
          setZoomLevel(prev => Math.max(prev - 0.05, 0.5));
        }
        pinchDistance.current = newDistance;
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && touchStartX.current !== 0 && pinchDistance.current === 0) {
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX.current;
      const deltaY = Math.abs(touchEndY - touchStartY.current);

      if (Math.abs(deltaX) > 80 && deltaY < 100) {
        if (deltaX > 0 && currentPage > 1) {
          setCurrentPage(p => p - 1);
        } else if (deltaX < 0 && currentPage < totalPages) {
          setCurrentPage(p => p + 1);
        }
      }
    }

    touchStartX.current = 0;
    touchStartY.current = 0;
    pinchDistance.current = 0;
  };


  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-16 w-16 border-4 border-amber-500/20 border-t-amber-500 mb-6"></div>
          <p className="text-gray-300 text-lg font-medium">Validation...</p>
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
        return 'Capture d\'écran détectée!';
      case 'print':
        return 'Impression interdite!';
      case 'copy':
        return 'Copie interdite!';
      case 'rightclick':
        return 'Clic droit désactivé.';
      default:
        return 'Action non autorisée!';
    }
  };

  return (
    <div
      className="min-h-screen select-none bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950"
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {showWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm animate-pulse">
          <div className="bg-gradient-to-br from-red-900 to-red-950 border-2 border-red-500 rounded-2xl p-6 max-w-sm mx-4 text-center shadow-2xl">
            <AlertCircle className="w-14 h-14 text-red-200 mx-auto mb-3 animate-bounce" />
            <h3 className="text-xl font-bold text-white mb-2">AVERTISSEMENT</h3>
            <p className="text-red-100 text-sm">{getWarningMessage(warningType)}</p>
          </div>
        </div>
      )}

      <div className="fixed top-0 left-0 right-0 z-50 border-b bg-slate-900/98 border-slate-800 backdrop-blur-lg shadow-xl">
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="p-1.5 bg-gradient-to-br from-amber-500 to-orange-500 rounded-lg shadow-lg flex-shrink-0">
                <Lock className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-white font-bold text-sm truncate">{tokenData?.pdfs?.titre}</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold text-sm">{currentPage}/{totalPages}</span>
              <button
                onClick={toggleFullscreen}
                className="p-2 text-gray-400 hover:text-white hover:bg-slate-700 rounded-lg transition-all bg-slate-800/50"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
              <button
                onClick={handleExtractArticles}
                disabled={extractingArticles}
                className="p-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-lg transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title="Mode Article"
              >
                <BookOpen className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <ArticleView
        articles={articles}
        currentArticleIndex={currentArticleIndex}
        isOpen={isArticleViewOpen}
        onClose={() => setIsArticleViewOpen(false)}
        onNavigate={(index) => setCurrentArticleIndex(index)}
      />

      <div className="flex items-center justify-center min-h-screen px-3 py-16 pb-10">
        <div className="relative w-full flex items-center justify-center">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="absolute left-1 top-1/2 -translate-y-1/2 z-10 p-2.5 bg-slate-900/95 hover:bg-slate-800 text-white rounded-full disabled:opacity-20 disabled:cursor-not-allowed transition-all shadow-2xl border border-slate-700"
          >
            <ChevronLeft className="w-7 h-7" />
          </button>

          <canvas
            ref={canvasRef}
            className="shadow-2xl transition-all duration-150 rounded-lg mx-auto"
            style={{
              userSelect: 'none',
              pointerEvents: 'none',
              touchAction: 'pan-x pan-y pinch-zoom',
              display: 'block',
              maxWidth: '100%',
              height: 'auto',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(100, 116, 139, 0.3)'
            }}
          />

          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="absolute right-1 top-1/2 -translate-y-1/2 z-10 p-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-full disabled:opacity-20 disabled:cursor-not-allowed transition-all shadow-2xl border border-amber-600"
          >
            <ChevronRight className="w-7 h-7" />
          </button>

          <div className="absolute -inset-3 bg-gradient-to-r from-amber-500/6 to-orange-500/6 rounded-2xl -z-10 blur-2xl"></div>
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
      `}</style>
    </div>
  );
}

declare global {
  interface Window {
    pdfjsLib: any;
    pdfDocument: any;
  }
}
