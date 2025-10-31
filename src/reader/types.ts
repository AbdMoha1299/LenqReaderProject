export interface ReaderManifest {
  edition: {
    id: string;
    title: string;
    publicationDate: string | null;
    totalPages: number;
  };
  pages: ReaderPage[];
  articles: Record<string, ReaderArticleSummary>;
}

export interface ReaderPage {
  id: string;
  pageNumber: number;
  width: number | null;
  height: number | null;
  lowResImageUrl: string;
  thumbnailUrl: string | null;
  tiles: ReaderTile[];
  hotspots: ReaderHotspot[];
}

export interface ReaderTile {
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

export interface ReaderHotspot {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  articleId: string;
}

export interface ReaderArticleSummary {
  id: string;
  title: string;
  subtitle: string | null;
  order: number | null;
  pageNumber: number | null;
}

export interface ReaderAccessContext {
  token: string;
  accessData: {
    userId: string;
    userName?: string;
    userNumber?: string;
    editionId: string;
    editionTitle?: string;
    pdfId?: string;
    sessionId: string;
  };
}

export interface ReaderState {
  status: 'loading' | 'ready' | 'error';
  currentPage: number;
  totalPages: number;
  zoom: number;
  mode: 'page' | 'article';
  activeArticleId: string | null;
  error?: string;
}

export type ReaderAction =
  | { type: 'SET_READY'; payload: { totalPages: number } }
  | { type: 'SET_PAGE'; payload: number }
  | { type: 'SET_MODE'; payload: 'page' | 'article' }
  | { type: 'SET_ACTIVE_ARTICLE'; payload: string | null }
  | { type: 'SET_ZOOM'; payload: number }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'RESET' };

