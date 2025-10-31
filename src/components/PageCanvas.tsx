import { useRef, useEffect, useCallback } from 'react';
import type { EditionManifest, ImageQuality } from '../types/reader';

interface PageCanvasProps {
  page: number;
  quality: ImageQuality;
  zoom: number;
  manifest: EditionManifest | null;
  baseUrl: string;
  cache: ReturnType<typeof import('../hooks/useImageCache').useImageCache>;
  onRenderComplete?: () => void;
  onRenderError?: (error: Error) => void;
  watermark?: {
    userName: string;
    userNumber: string;
    sessionId: string;
  };
}

/**
 * Composant de rendu canvas pour afficher une page
 * Optimisé pour les performances avec cache et gestion du DPR
 */
export function PageCanvas({
  page,
  quality,
  zoom,
  manifest,
  baseUrl,
  cache,
  onRenderComplete,
  onRenderError,
  watermark,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderingRef = useRef(false);
  const currentRenderRef = useRef<{ page: number; quality: ImageQuality; zoom: number } | null>(null);

  const applyWatermark = useCallback((
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    if (!watermark) return;

    ctx.save();
    ctx.globalAlpha = 0.08;

    const fontSize = Math.max(14, Math.min(width * 0.02, 24));
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';

    const centerX = width / 2;
    const centerY = height / 2;

    ctx.translate(centerX, centerY);
    ctx.rotate(-Math.PI / 8);

    const sessionShort = watermark.sessionId.substring(0, 8).toUpperCase();
    const timestamp = new Date().toLocaleString('fr-FR');

    ctx.fillText(watermark.userName.toUpperCase(), 0, -fontSize * 1.5);
    ctx.fillText(watermark.userNumber, 0, 0);
    ctx.fillText(timestamp, 0, fontSize * 1.5);
    ctx.fillText(`ID: ${sessionShort} - P${page}`, 0, fontSize * 3);

    ctx.restore();
  }, [watermark, page]);

  const renderPage = useCallback(async () => {
    if (!manifest || !canvasRef.current) return;
    if (renderingRef.current) return;

    // Vérifier si le rendu est nécessaire
    if (
      currentRenderRef.current &&
      currentRenderRef.current.page === page &&
      currentRenderRef.current.quality === quality &&
      currentRenderRef.current.zoom === zoom
    ) {
      return;
    }

    renderingRef.current = true;

    try {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Cannot get 2D context');

      const pageData = manifest.pages[page - 1];
      if (!pageData) throw new Error(`Page ${page} not found in manifest`);

      // Essayer d'obtenir l'image du cache
      let img = cache.get(page, quality);

      // Si pas en cache, charger
      if (!img) {
        const imageUrl = `${baseUrl}${pageData.sizes[quality].url}`;
        img = new Image();
        img.decoding = 'async';

        await new Promise<void>((resolve, reject) => {
          img!.onload = () => resolve();
          img!.onerror = () => reject(new Error(`Failed to load image: ${imageUrl}`));
          img!.src = imageUrl;
        });

        // Mettre en cache
        const sizeBytes = pageData.sizes[quality].sizeBytes;
        cache.set(page, quality, img, sizeBytes);
      }

      // Calculer les dimensions avec DPR et zoom
      const dpr = window.devicePixelRatio || 1;
      const displayWidth = img.naturalWidth * zoom;
      const displayHeight = img.naturalHeight * zoom;

      canvas.width = Math.round(displayWidth * dpr);
      canvas.height = Math.round(displayHeight * dpr);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;

      // Configurer le contexte pour un rendu de haute qualité
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Effacer et dessiner
      ctx.clearRect(0, 0, displayWidth, displayHeight);
      ctx.drawImage(img, 0, 0, displayWidth, displayHeight);

      // Appliquer le filigrane
      applyWatermark(ctx, displayWidth, displayHeight);

      // Marquer comme rendu
      currentRenderRef.current = { page, quality, zoom };
      onRenderComplete?.();
    } catch (error) {
      console.error('Error rendering page:', error);
      onRenderError?.(error as Error);
    } finally {
      renderingRef.current = false;
    }
  }, [manifest, page, quality, zoom, cache, baseUrl, applyWatermark, onRenderComplete, onRenderError]);

  // Re-rendre quand les paramètres changent
  useEffect(() => {
    renderPage();
  }, [renderPage]);

  return (
    <canvas
      ref={canvasRef}
      className="block max-w-full h-auto"
      style={{ backgroundColor: '#ffffff' }}
    />
  );
}
