import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  EditionManifest,
  ReaderState,
  ReaderConfig,
  ImageQuality,
  ReaderMode,
  NavigationEvent,
  ZoomEvent
} from '../types/reader';
import { usePreloader } from './usePreloader';

const DEFAULT_CONFIG: ReaderConfig = {
  enableTransitions: true,
  enablePreloading: true,
  preloadDistance: 3,
  cacheSize: 10,
  defaultQuality: 'medium',
  autoQuality: true,
};

interface UseImageReaderOptions {
  editionId: string;
  baseUrl: string;
  config?: Partial<ReaderConfig>;
  onNavigate?: (event: NavigationEvent) => void;
  onZoom?: (event: ZoomEvent) => void;
}

/**
 * Hook principal pour le lecteur d'images moderne
 * Gère l'état, la navigation, le zoom et le préchargement
 */
export function useImageReader(options: UseImageReaderOptions) {
  const { editionId, baseUrl, config: userConfig, onNavigate, onZoom } = options;
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  const [manifest, setManifest] = useState<EditionManifest | null>(null);
  const [state, setState] = useState<ReaderState>({
    currentPage: 1,
    zoom: 1,
    mode: 'spread',
    quality: config.defaultQuality,
    transition: config.enableTransitions ? 'fade' : 'none',
    isFullscreen: false,
    tocOpen: false,
    ready: false,
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastNavigationRef = useRef<NavigationEvent | null>(null);

  // Préchargeur intelligent
  const preloader = usePreloader({
    distance: config.preloadDistance,
    enabled: config.enablePreloading && state.ready,
    currentPage: state.currentPage,
    totalPages: manifest?.totalPages || 0,
    quality: state.quality,
    manifest,
    baseUrl,
  });

  // Charger le manifest de l'édition
  useEffect(() => {
    const loadManifest = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${baseUrl}/editions/${editionId}/manifest.json`);

        if (!response.ok) {
          throw new Error(`Failed to load manifest: ${response.statusText}`);
        }

        const data: EditionManifest = await response.json();
        setManifest(data);
        setState(s => ({ ...s, ready: true }));
      } catch (err) {
        console.error('Error loading manifest:', err);
        setError(err instanceof Error ? err.message : 'Failed to load edition');
      } finally {
        setLoading(false);
      }
    };

    loadManifest();
  }, [editionId, baseUrl]);

  // Adapter la qualité selon la connexion (si autoQuality activé)
  useEffect(() => {
    if (!config.autoQuality || typeof navigator === 'undefined') return;

    const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    if (!connection) return;

    const updateQuality = () => {
      const effectiveType = connection.effectiveType;
      let newQuality: ImageQuality = 'medium';

      if (effectiveType === '4g') {
        newQuality = 'high';
      } else if (effectiveType === '3g') {
        newQuality = 'medium';
      } else {
        newQuality = 'low';
      }

      setState(s => ({ ...s, quality: newQuality }));
    };

    updateQuality();
    connection.addEventListener('change', updateQuality);

    return () => {
      connection.removeEventListener('change', updateQuality);
    };
  }, [config.autoQuality]);

  // Navigation
  const goToPage = useCallback((page: number, trigger: NavigationEvent['trigger'] = 'click') => {
    if (!manifest) return;

    const clamped = Math.max(1, Math.min(page, manifest.totalPages));

    const event: NavigationEvent = {
      fromPage: state.currentPage,
      toPage: clamped,
      trigger,
    };

    lastNavigationRef.current = event;
    onNavigate?.(event);

    setState(s => ({ ...s, currentPage: clamped }));
  }, [manifest, state.currentPage, onNavigate]);

  const nextPage = useCallback(() => {
    if (!manifest) return;

    let next = state.currentPage + 1;
    if (state.mode === 'spread' && state.currentPage > 1) {
      // En mode double page, sauter 2 pages
      next = state.currentPage + 2;
    }

    goToPage(next, 'click');
  }, [manifest, state.currentPage, state.mode, goToPage]);

  const previousPage = useCallback(() => {
    if (!manifest) return;

    let prev = state.currentPage - 1;
    if (state.mode === 'spread' && state.currentPage > 1) {
      // En mode double page, reculer de 2 pages
      prev = state.currentPage - 2;
    }

    goToPage(prev, 'click');
  }, [manifest, state.currentPage, state.mode, goToPage]);

  const firstPage = useCallback(() => {
    goToPage(1, 'click');
  }, [goToPage]);

  const lastPage = useCallback(() => {
    if (!manifest) return;
    goToPage(manifest.totalPages, 'click');
  }, [manifest, goToPage]);

  // Zoom
  const setZoom = useCallback((zoom: number | ((prev: number) => number)) => {
    const newZoom = typeof zoom === 'function' ? zoom(state.zoom) : zoom;
    const clamped = Math.max(0.5, Math.min(5, newZoom));

    const event: ZoomEvent = {
      fromZoom: state.zoom,
      toZoom: clamped,
    };

    onZoom?.(event);
    setState(s => ({ ...s, zoom: clamped }));
  }, [state.zoom, onZoom]);

  const zoomIn = useCallback((step: number = 0.25) => {
    setZoom(z => z + step);
  }, [setZoom]);

  const zoomOut = useCallback((step: number = 0.25) => {
    setZoom(z => z - step);
  }, [setZoom]);

  const resetZoom = useCallback(() => {
    setZoom(1);
  }, [setZoom]);

  // Modes de lecture
  const setMode = useCallback((mode: ReaderMode) => {
    setState(s => ({ ...s, mode }));
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      setState(s => ({ ...s, isFullscreen: true }));
    } else {
      await document.exitFullscreen();
      setState(s => ({ ...s, isFullscreen: false }));
    }
  }, []);

  const toggleToc = useCallback(() => {
    setState(s => ({ ...s, tocOpen: !s.tocOpen }));
  }, []);

  // Raccourcis clavier
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignorer si un input est focus
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          previousPage();
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextPage();
          break;
        case '+':
        case '=':
          e.preventDefault();
          zoomIn();
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomOut();
          break;
        case '0':
          e.preventDefault();
          resetZoom();
          break;
        case 'Home':
          e.preventDefault();
          firstPage();
          break;
        case 'End':
          e.preventDefault();
          lastPage();
          break;
        case 'Escape':
          e.preventDefault();
          if (state.isFullscreen) {
            toggleFullscreen();
          } else if (state.tocOpen) {
            toggleToc();
          }
          break;
        case 'f':
        case 'F':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleFullscreen();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previousPage, nextPage, zoomIn, zoomOut, resetZoom, firstPage, lastPage, toggleFullscreen, toggleToc, state.isFullscreen, state.tocOpen]);

  // Gérer changement fullscreen (via F11 ou bouton navigateur)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setState(s => ({ ...s, isFullscreen: Boolean(document.fullscreenElement) }));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Calculer l'état de navigation
  const canGoNext = manifest ? state.currentPage < manifest.totalPages : false;
  const canGoPrevious = state.currentPage > 1;

  return {
    // État
    state,
    manifest,
    loading,
    error,

    // Navigation
    goToPage,
    nextPage,
    previousPage,
    firstPage,
    lastPage,
    canGoNext,
    canGoPrevious,

    // Zoom
    zoom: state.zoom,
    setZoom,
    zoomIn,
    zoomOut,
    resetZoom,

    // Modes
    mode: state.mode,
    setMode,
    toggleFullscreen,
    toggleToc,

    // Qualité
    quality: state.quality,
    setQuality: (quality: ImageQuality) => setState(s => ({ ...s, quality })),

    // Cache et préchargement
    preloader,
    cacheStats: preloader.cache.getStats(),
  };
}
