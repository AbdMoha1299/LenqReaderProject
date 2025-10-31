import { useRef, useCallback } from 'react';
import type { ImageQuality } from '../types/reader';

interface CacheEntry {
  image: HTMLImageElement;
  quality: ImageQuality;
  loadedAt: number;
  sizeBytes: number;
  accessCount: number;
  lastAccessed: number;
}

/**
 * Cache LRU (Least Recently Used) pour les images du lecteur
 * Garde en mémoire les images les plus récemment utilisées
 */
export function useImageCache(maxEntries: number = 10, maxSizeBytes: number = 100 * 1024 * 1024) {
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const statsRef = useRef({
    hits: 0,
    misses: 0,
    evictions: 0,
    totalBytesLoaded: 0,
  });

  const getCacheKey = useCallback((page: number, quality: ImageQuality) => {
    return `${page}-${quality}`;
  }, []);

  const getTotalCacheSize = useCallback(() => {
    let total = 0;
    for (const entry of cacheRef.current.values()) {
      total += entry.sizeBytes;
    }
    return total;
  }, []);

  const evictLRU = useCallback(() => {
    if (cacheRef.current.size === 0) return;

    // Trouver l'entrée la moins récemment utilisée
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of cacheRef.current.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      cacheRef.current.delete(oldestKey);
      statsRef.current.evictions++;
    }
  }, []);

  const enforceCapacity = useCallback(() => {
    // Respecter la limite de nombre d'entrées
    while (cacheRef.current.size > maxEntries) {
      evictLRU();
    }

    // Respecter la limite de taille totale
    while (getTotalCacheSize() > maxSizeBytes && cacheRef.current.size > 0) {
      evictLRU();
    }
  }, [evictLRU, getTotalCacheSize, maxEntries, maxSizeBytes]);

  const get = useCallback((page: number, quality: ImageQuality): HTMLImageElement | null => {
    const key = getCacheKey(page, quality);
    const entry = cacheRef.current.get(key);

    if (!entry) {
      statsRef.current.misses++;
      return null;
    }

    // Mettre à jour les stats d'accès (LRU)
    entry.accessCount++;
    entry.lastAccessed = Date.now();

    // Déplacer à la fin (plus récent)
    cacheRef.current.delete(key);
    cacheRef.current.set(key, entry);

    statsRef.current.hits++;
    return entry.image;
  }, [getCacheKey]);

  const set = useCallback((page: number, quality: ImageQuality, image: HTMLImageElement, sizeBytes: number) => {
    const key = getCacheKey(page, quality);

    // Si déjà en cache, mettre à jour
    if (cacheRef.current.has(key)) {
      cacheRef.current.delete(key);
    }

    const entry: CacheEntry = {
      image,
      quality,
      loadedAt: Date.now(),
      sizeBytes,
      accessCount: 1,
      lastAccessed: Date.now(),
    };

    cacheRef.current.set(key, entry);
    statsRef.current.totalBytesLoaded += sizeBytes;

    enforceCapacity();
  }, [getCacheKey, enforceCapacity]);

  const has = useCallback((page: number, quality: ImageQuality): boolean => {
    const key = getCacheKey(page, quality);
    return cacheRef.current.has(key);
  }, [getCacheKey]);

  const clear = useCallback(() => {
    cacheRef.current.clear();
    statsRef.current = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalBytesLoaded: 0,
    };
  }, []);

  const getStats = useCallback(() => {
    const totalSize = getTotalCacheSize();
    const hitRate = statsRef.current.hits + statsRef.current.misses > 0
      ? statsRef.current.hits / (statsRef.current.hits + statsRef.current.misses)
      : 0;

    return {
      size: cacheRef.current.size,
      maxSize: maxEntries,
      totalBytes: totalSize,
      maxBytes: maxSizeBytes,
      hitRate: hitRate * 100,
      ...statsRef.current,
    };
  }, [getTotalCacheSize, maxEntries, maxSizeBytes]);

  const prefetch = useCallback((page: number, quality: ImageQuality, url: string): Promise<void> => {
    // Si déjà en cache, ne rien faire
    if (has(page, quality)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';

      img.onload = () => {
        // Estimer la taille (approximatif)
        const sizeBytes = img.naturalWidth * img.naturalHeight * 3; // RGB
        set(page, quality, img, sizeBytes);
        resolve();
      };

      img.onerror = reject;
      img.src = url;
    });
  }, [has, set]);

  return {
    get,
    set,
    has,
    clear,
    getStats,
    prefetch,
  };
}
