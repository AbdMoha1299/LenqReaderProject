// Types pour le système de lecture moderne basé sur images

export interface EditionManifest {
  editionId: string;
  title: string;
  date: string;
  totalPages: number;
  format: {
    width: number;
    height: number;
    ratio: number;
  };
  pages: PageMetadata[];
  articles: ArticleMetadata[];
  coverImage?: string;
  thumbnailGrid?: string;
}

export interface PageMetadata {
  number: number;
  thumb: string;
  sizes: {
    low: ImageSize;
    medium: ImageSize;
    high: ImageSize;
  };
  articleIds: string[];
}

export interface ImageSize {
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ArticleMetadata {
  id: string;
  title: string;
  subtitle?: string;
  page: number;
  bounds: BoundingBox;
  category?: string;
  author?: string;
  readingTime?: number;
  ordre: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ReaderMode = 'single' | 'spread' | 'continuous' | 'grid';
export type ImageQuality = 'low' | 'medium' | 'high';
export type TransitionType = 'none' | 'fade' | 'slide' | 'curl';

export interface ReaderState {
  currentPage: number;
  zoom: number;
  mode: ReaderMode;
  quality: ImageQuality;
  transition: TransitionType;
  isFullscreen: boolean;
  tocOpen: boolean;
  ready: boolean;
}

export interface ReaderConfig {
  enableTransitions: boolean;
  enablePreloading: boolean;
  preloadDistance: number; // Nombre de pages à précharger avant/après
  cacheSize: number; // Nombre de pages en cache
  defaultQuality: ImageQuality;
  autoQuality: boolean; // Adapter la qualité selon la connexion
}

export interface CachedImage {
  element: HTMLImageElement;
  quality: ImageQuality;
  loadedAt: number;
  sizeBytes: number;
}

export interface PreloadTask {
  page: number;
  quality: ImageQuality;
  priority: 'high' | 'medium' | 'low';
}

export interface NavigationEvent {
  fromPage: number;
  toPage: number;
  trigger: 'click' | 'swipe' | 'keyboard' | 'hotspot';
}

export interface ZoomEvent {
  fromZoom: number;
  toZoom: number;
  centerX?: number;
  centerY?: number;
}

export interface ReaderAnalytics {
  sessionId: string;
  editionId: string;
  userId: string;
  startedAt: Date;
  pageVisits: Map<number, number>; // page -> temps passé en secondes
  articlesRead: Set<string>;
  zoomUsed: boolean;
  modesUsed: Set<ReaderMode>;
}
