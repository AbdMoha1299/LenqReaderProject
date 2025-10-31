import { useRef, useCallback, useEffect } from 'react';
import type { EditionManifest, ImageQuality, PreloadTask } from '../types/reader';
import { useImageCache } from './useImageCache';

interface PreloadOptions {
  distance: number; // Nombre de pages avant/après à précharger
  enabled: boolean;
  currentPage: number;
  totalPages: number;
  quality: ImageQuality;
  manifest: EditionManifest | null;
  baseUrl: string;
}

/**
 * Hook pour gérer le préchargement intelligent des images
 * Charge en arrière-plan les pages adjacentes pour une navigation fluide
 */
export function usePreloader(options: PreloadOptions) {
  const { distance, enabled, currentPage, totalPages, quality, manifest, baseUrl } = options;
  const cache = useImageCache();
  const queueRef = useRef<PreloadTask[]>([]);
  const loadingRef = useRef(new Set<string>());
  const abortControllersRef = useRef(new Map<string, AbortController>());

  const getTaskKey = useCallback((page: number, quality: ImageQuality) => {
    return `${page}-${quality}`;
  }, []);

  const calculatePriority = useCallback((page: number, currentPage: number): PreloadTask['priority'] => {
    const distance = Math.abs(page - currentPage);
    if (distance === 0) return 'high';
    if (distance === 1) return 'high';
    if (distance <= 2) return 'medium';
    return 'low';
  }, []);

  const buildQueue = useCallback(() => {
    if (!manifest || !enabled) return [];

    const queue: PreloadTask[] = [];
    const visited = new Set<number>();

    // Pages visibles (priorité maximale)
    visited.add(currentPage);
    queue.push({
      page: currentPage,
      quality,
      priority: 'high',
    });

    // Pages adjacentes (priorité haute)
    const adjacentPages = [currentPage - 1, currentPage + 1];
    for (const page of adjacentPages) {
      if (page >= 1 && page <= totalPages && !visited.has(page)) {
        visited.add(page);
        queue.push({
          page,
          quality,
          priority: 'high',
        });
      }
    }

    // Pages proches (priorité moyenne)
    for (let i = 2; i <= distance; i++) {
      const pages = [currentPage - i, currentPage + i];
      for (const page of pages) {
        if (page >= 1 && page <= totalPages && !visited.has(page)) {
          visited.add(page);
          queue.push({
            page,
            quality,
            priority: calculatePriority(page, currentPage),
          });
        }
      }
    }

    return queue;
  }, [manifest, enabled, currentPage, quality, totalPages, distance, calculatePriority]);

  const loadImage = useCallback(async (task: PreloadTask): Promise<void> => {
    if (!manifest) return;

    const taskKey = getTaskKey(task.page, task.quality);

    // Déjà en cache
    if (cache.has(task.page, task.quality)) {
      return;
    }

    // Déjà en cours de chargement
    if (loadingRef.current.has(taskKey)) {
      return;
    }

    const pageData = manifest.pages[task.page - 1];
    if (!pageData) return;

    const imageUrl = `${baseUrl}${pageData.sizes[task.quality].url}`;

    loadingRef.current.add(taskKey);

    const controller = new AbortController();
    abortControllersRef.current.set(taskKey, controller);

    try {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = task.priority === 'high' ? 'high' : 'low';

      await new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
          img.src = '';
          reject(new DOMException('Aborted', 'AbortError'));
        };

        if (controller.signal.aborted) {
          handleAbort();
          return;
        }

        controller.signal.addEventListener('abort', handleAbort);

        img.onload = () => {
          controller.signal.removeEventListener('abort', handleAbort);
          const sizeBytes = pageData.sizes[task.quality].sizeBytes;
          cache.set(task.page, task.quality, img, sizeBytes);
          resolve();
        };

        img.onerror = () => {
          controller.signal.removeEventListener('abort', handleAbort);
          reject(new Error(`Failed to load image for page ${task.page}`));
        };

        img.src = imageUrl;
      });
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') {
        console.warn(`Preload failed for page ${task.page}:`, error);
      }
    } finally {
      loadingRef.current.delete(taskKey);
      abortControllersRef.current.delete(taskKey);
    }
  }, [manifest, cache, getTaskKey, baseUrl]);

  const processQueue = useCallback(async () => {
    const queue = queueRef.current;
    if (queue.length === 0) return;

    // Trier par priorité
    const sorted = [...queue].sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // Charger avec concurrence limitée
    const concurrency = 3;
    const chunks: PreloadTask[][] = [];

    for (let i = 0; i < sorted.length; i += concurrency) {
      chunks.push(sorted.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(chunk.map(task => loadImage(task)));
    }

    queueRef.current = [];
  }, [loadImage]);

  // Mettre à jour la queue quand les paramètres changent
  useEffect(() => {
    if (!enabled || !manifest) return;

    // Annuler les chargements en cours qui ne sont plus pertinents
    const newQueue = buildQueue();
    const newKeys = new Set(newQueue.map(t => getTaskKey(t.page, t.quality)));

    for (const [key, controller] of abortControllersRef.current.entries()) {
      if (!newKeys.has(key)) {
        controller.abort();
      }
    }

    queueRef.current = newQueue;
    processQueue();
  }, [enabled, manifest, currentPage, quality, distance, buildQueue, processQueue, getTaskKey]);

  // Nettoyage à la fin
  useEffect(() => {
    return () => {
      for (const controller of abortControllersRef.current.values()) {
        controller.abort();
      }
      abortControllersRef.current.clear();
      loadingRef.current.clear();
    };
  }, []);

  const getLoadingStatus = useCallback(() => {
    return {
      queueSize: queueRef.current.length,
      activeLoads: loadingRef.current.size,
      cacheStats: cache.getStats(),
    };
  }, [cache]);

  return {
    getLoadingStatus,
    cache,
  };
}
