import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize,
  Minimize,
  BookOpen,
  X,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { useImageReader } from '../hooks/useImageReader';
import { PageCanvas } from './PageCanvas';
import type { ReaderAccessData } from './ModernPDFReader'; // Garder la compatibilité

interface ModernImageReaderProps {
  token: string;
  initialData?: ReaderAccessData;
}

/**
 * Lecteur moderne basé sur des images optimisées (WebP/AVIF)
 * Architecture simplifiée et performante - ~500 lignes vs 2139 pour ModernPDFReader
 */
export function ModernImageReader({ token, initialData }: ModernImageReaderProps) {
  const [sessionId] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accessData, setAccessData] = useState<ReaderAccessData | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef({ x: 0, y: 0, time: 0 });

  // Hook principal du lecteur
  const reader = useImageReader({
    editionId: accessData?.editionId || '',
    baseUrl: '/cdn',
    config: {
      enablePreloading: true,
      preloadDistance: 3,
      cacheSize: 10,
      defaultQuality: 'medium',
      autoQuality: true,
    },
    onNavigate: (event) => {
      console.log('Navigation:', event);
      // TODO: Log analytics
    },
    onZoom: (event) => {
      console.log('Zoom:', event);
    },
  });

  // Valider le token
  useEffect(() => {
    const validateToken = async () => {
      if (initialData?.pdfUrl) {
        setAccessData(initialData);
        setLoading(false);
        return;
      }

      try {
        const deviceFingerprint = {
          userAgent: navigator.userAgent,
          screenResolution: `${screen.width}x${screen.height}`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
        };

        let ipAddress = '';
        try {
          const ipResponse = await fetch('https://api.ipify.org?format=json', {
            signal: AbortSignal.timeout(4000),
          });
          ipAddress = (await ipResponse.json()).ip;
        } catch {
          console.warn('Could not fetch IP');
        }

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
          const reason = data?.reason || '';
          const baseError = data?.error || 'Token invalide';
          setError(reason ? `${baseError} : ${reason}` : baseError);
          return;
        }

        setAccessData(data);
      } catch (err) {
        console.error('Error validating token:', err);
        setError(err instanceof Error ? err.message : 'Erreur lors de la validation');
      } finally {
        setLoading(false);
      }
    };

    validateToken();
  }, [token, initialData]);

  // Gestion tactile (swipe et pinch)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now(),
      };
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.changedTouches.length === 1) {
      const touchEnd = e.changedTouches[0];
      const deltaX = touchEnd.clientX - touchStartRef.current.x;
      const deltaY = Math.abs(touchEnd.clientY - touchStartRef.current.y);
      const deltaTime = Date.now() - touchStartRef.current.time;

      // Swipe horizontal pour changer de page
      if (Math.abs(deltaX) > 100 && deltaY < 80 && deltaTime < 500) {
        if (deltaX > 0) {
          reader.previousPage();
        } else {
          reader.nextPage();
        }
      }
    }

    touchStartRef.current = { x: 0, y: 0, time: 0 };
  }, [reader]);

  const handleExit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }

    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  }, []);

  // États de chargement et d'erreur
  if (loading || reader.loading) {
    return (
      <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-16 w-16 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
          <p className="text-[#1f3b63] text-sm sm:text-base font-medium">Chargement...</p>
        </div>
      </div>
    );
  }

  if (error || reader.error) {
    return (
      <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-[#f1c2c2] shadow-xl rounded-3xl px-8 py-10 text-center">
          <AlertCircle className="w-16 h-16 text-[#d14343] mx-auto mb-6" />
          <h2 className="text-xl font-semibold text-[#1f3b63] mb-2">Accès refusé</h2>
          <p className="text-sm text-[#60719d]">{error || reader.error}</p>
        </div>
      </div>
    );
  }

  if (!accessData || !reader.manifest) {
    return null;
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const totalPages = reader.manifest.totalPages;

  const controlButtonClass =
    'h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] flex items-center justify-center shadow-sm transition hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#1f3b63]';

  const mobileNavButtonClass =
    'flex-1 min-w-[68px] flex flex-col items-center justify-center rounded-2xl border border-[#dfe5f2] bg-white text-[#1f3b63] text-xs font-semibold py-2 px-2 shadow-sm active:scale-[0.97] transition disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div
      className="min-h-screen bg-[#f1f2f6] text-[#1f3b63] flex flex-col select-none"
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header */}
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
                L'ENQUÊTEUR
              </span>
              {reader.manifest.title && (
                <span className="text-sm sm:text-base font-medium text-[#1f3b63] truncate">
                  {reader.manifest.title}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#d7deec] bg-white text-xs font-semibold text-[#1f3b63] shadow-sm">
              <BookOpen className="w-4 h-4" />
              <span>
                Page {reader.state.currentPage} / {totalPages}
              </span>
            </div>
            <button
              type="button"
              onClick={() => reader.zoomOut()}
              disabled={reader.zoom <= 0.5}
              className={controlButtonClass}
              title="Zoom arrière"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => reader.zoomIn()}
              disabled={reader.zoom >= 3}
              className={controlButtonClass}
              title="Zoom avant"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={reader.toggleFullscreen}
              className={controlButtonClass}
              title={reader.state.isFullscreen ? 'Quitter plein écran' : 'Plein écran'}
            >
              {reader.state.isFullscreen ? (
                <Minimize className="w-4 h-4" />
              ) : (
                <Maximize className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className={`flex-1 w-full relative pt-24 px-4 ${isMobile ? 'pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]' : 'pb-20'}`}>
        <div className="relative mx-auto flex items-center justify-center max-w-5xl">
          {/* Bouton page précédente */}
          {!isMobile && reader.canGoPrevious && (
            <button
              type="button"
              onClick={reader.previousPage}
              className="absolute left-6 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 px-3 py-4 rounded-full bg-white border border-[#d7deec] text-[#1f3b63] shadow-lg transition hover:-translate-x-1 disabled:opacity-40"
              title="Page précédente"
            >
              <ChevronLeft className="w-5 h-5" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
                P {reader.state.currentPage - 1}
              </span>
            </button>
          )}

          {/* Canvas de la page */}
          <div className="relative border border-[#dfe5f2] bg-white shadow-[0_30px_80px_-35px_rgba(15,31,64,0.6)]">
            <PageCanvas
              page={reader.state.currentPage}
              quality={reader.state.quality}
              zoom={reader.zoom}
              manifest={reader.manifest}
              baseUrl="/cdn"
              cache={reader.preloader.cache}
              watermark={{
                userName: accessData.userName || '',
                userNumber: accessData.userNumber || '',
                sessionId,
              }}
            />
          </div>

          {/* Bouton page suivante */}
          {!isMobile && reader.canGoNext && (
            <button
              type="button"
              onClick={reader.nextPage}
              className="absolute right-6 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 px-3 py-4 rounded-full bg-white border border-[#d7deec] text-[#1f3b63] shadow-lg transition hover:translate-x-1 disabled:opacity-40"
              title="Page suivante"
            >
              <ChevronRight className="w-5 h-5" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
                P {reader.state.currentPage + 1}
              </span>
            </button>
          )}
        </div>
      </main>

      {/* Navigation mobile */}
      {isMobile && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 border-t border-[#dfe5f2] backdrop-blur-md px-4 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] pt-3">
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <button
              type="button"
              onClick={reader.previousPage}
              disabled={!reader.canGoPrevious}
              className={mobileNavButtonClass}
              title="Page précédente"
            >
              <ChevronLeft className="w-4 h-4 mb-1" />
              <span>Précédente</span>
            </button>
            <button
              type="button"
              onClick={reader.toggleToc}
              className={`${mobileNavButtonClass} ${reader.state.tocOpen ? 'bg-[#1f3b63] text-white border-[#1f3b63]' : ''}`}
              title="Sommaire"
            >
              <ChevronUp
                className="w-4 h-4 mb-1 transition-transform duration-150"
                style={{ transform: reader.state.tocOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              />
              <span>Sommaire</span>
            </button>
            <button
              type="button"
              onClick={reader.nextPage}
              disabled={!reader.canGoNext}
              className={mobileNavButtonClass}
              title="Page suivante"
            >
              <ChevronRight className="w-4 h-4 mb-1" />
              <span>Suivante</span>
            </button>
          </div>
        </nav>
      )}

      {/* Table des matières */}
      {totalPages > 1 && (
        <>
          {!isMobile && (
            <button
              type="button"
              onClick={reader.toggleToc}
              className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] shadow-md flex items-center justify-center transition hover:shadow-lg"
              title={reader.state.tocOpen ? 'Masquer la table des matières' : 'Afficher la table des matières'}
            >
              {reader.state.tocOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
            </button>
          )}

          <div
            className={`fixed left-0 right-0 z-30 transform transition-transform duration-300 ${
              reader.state.tocOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
            }`}
            style={{
              bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 86px)' : '0px',
            }}
          >
            <div className="mx-auto max-w-6xl bg-white/95 border-t border-[#dfe5f2] shadow-lg rounded-t-3xl px-4 py-4 backdrop-blur-md">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-[#1f3b63] uppercase tracking-wide">Table des matières</p>
                <span className="text-[11px] text-[#60719d]">
                  {reader.state.currentPage} / {totalPages}
                </span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNumber = index + 1;
                  const isActive = pageNumber === reader.state.currentPage;
                  return (
                    <button
                      key={pageNumber}
                      type="button"
                      onClick={() => reader.goToPage(pageNumber)}
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

      {/* Styles de sécurité */}
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
  );
}
