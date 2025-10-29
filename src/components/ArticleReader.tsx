import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Clock,
  FileText,
  ArrowLeft,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Article {
  id: string;
  titre: string;
  sous_titre: string | null;
  auteur: string | null;
  contenu_texte: string;
  temps_lecture_estime: number;
  ordre_lecture: number;
  extraction_method: string;
  textract_confidence?: number;
  mots_count?: number;
}

interface ArticleReaderProps {
  editionId: string;
  userId: string;
  userName: string;
  userNumber: string;
  sessionId: string;
  onBackToPDF: () => void;
  initialArticleId?: string | null;
  onArticleChange?: (articleId: string) => void;
  editionLabel?: string;
}

export function ArticleReader({
  editionId,
  userId,
  userName,
  userNumber,
  sessionId,
  onBackToPDF,
  initialArticleId,
  onArticleChange,
  editionLabel,
}: ArticleReaderProps) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readArticles, setReadArticles] = useState<Set<string>>(new Set());
  const [articleProgress, setArticleProgress] = useState(0);
  const articleStartTimeRef = useRef(Date.now());
  const syncingFromPropRef = useRef(false);
  const previousArticleIdRef = useRef<string | null>(null);
  const articleContentRef = useRef<HTMLDivElement | null>(null);
  const articleProgressRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    loadArticles();
  }, [editionId]);

  useEffect(() => {
    if (!articles.length || !initialArticleId) {
      return;
    }

    const index = articles.findIndex(article => article.id === initialArticleId);
    if (index < 0) {
      return;
    }

    if (
      previousArticleIdRef.current &&
      initialArticleId === previousArticleIdRef.current &&
      index !== currentIndex
    ) {
      return;
    }

    if (index !== currentIndex) {
      syncingFromPropRef.current = true;
      setCurrentIndex(index);
    }
  }, [articles, initialArticleId, currentIndex]);

  const currentArticle = articles[currentIndex];
  const currentArticleId = currentArticle?.id;

  const updateArticleProgress = useCallback(() => {
    if (typeof window === 'undefined') return;

    const element = articleContentRef.current;
    if (!element) {
      if (articleProgressRef.current !== 0) {
        articleProgressRef.current = 0;
        setArticleProgress(0);
      }
      return;
    }

    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 1;
    const articleHeight = element.offsetHeight || 1;

    let nextProgress = 0;

    if (rect.top >= 0) {
      nextProgress = 0;
    } else if (rect.bottom <= viewportHeight) {
      nextProgress = 100;
    } else {
      const maxScrollable = Math.max(articleHeight - viewportHeight, 1);
      nextProgress = Math.min(Math.max(-rect.top / maxScrollable, 0), 1) * 100;
    }

    const clamped = Math.max(0, Math.min(100, Number(nextProgress.toFixed(2))));
    if (Math.abs(clamped - articleProgressRef.current) > 0.5) {
      articleProgressRef.current = clamped;
      setArticleProgress(clamped);
    }
  }, []);

  const scheduleProgressUpdate = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(updateArticleProgress);
  }, [updateArticleProgress]);

  useEffect(() => {
    if (!currentArticleId) return;

    const article = articles.find(item => item.id === currentArticleId);
    if (!article) return;

    const isSameArticle =
      previousArticleIdRef.current === currentArticleId && !syncingFromPropRef.current;

    const isSyncingToTarget =
      syncingFromPropRef.current &&
      initialArticleId &&
      currentArticleId !== initialArticleId;

    if (isSyncingToTarget) {
      return;
    }

    if (isSameArticle) {
      return;
    }

    trackArticleView(article);

    if (syncingFromPropRef.current) {
      syncingFromPropRef.current = false;
    } else {
      onArticleChange?.(currentArticleId);
    }

    previousArticleIdRef.current = currentArticleId;
    articleStartTimeRef.current = Date.now();

    if (articleContentRef.current) {
      articleContentRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    return () => {
      logReadingTime(article);
    };
  }, [currentArticleId, articles, initialArticleId, onArticleChange]);

  useEffect(() => {
    scheduleProgressUpdate();
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', scheduleProgressUpdate, { passive: true });
      window.addEventListener('resize', scheduleProgressUpdate);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('scroll', scheduleProgressUpdate);
        window.removeEventListener('resize', scheduleProgressUpdate);
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      }
    };
  }, [scheduleProgressUpdate]);

  useEffect(() => {
    articleProgressRef.current = 0;
    setArticleProgress(0);
    scheduleProgressUpdate();
  }, [currentArticleId, scheduleProgressUpdate]);

  const loadArticles = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('articles')
        .select('*')
        .eq('edition_id', editionId)
        .order('ordre_lecture', { ascending: true });

      if (error) throw error;
      setArticles(data || []);

      const { data: lecturesData } = await supabase
        .from('lectures_articles')
        .select('article_id')
        .eq('user_id', userId);

      if (lecturesData) {
        setReadArticles(new Set(lecturesData.map(l => l.article_id)));
      }
    } catch (error) {
      console.error('Error loading articles:', error);
    } finally {
      setLoading(false);
    }
  };

  const trackArticleView = async (article: Article) => {
    try {
      await supabase.from('lectures_articles').upsert(
        {
          user_id: userId,
          article_id: article.id,
          complete: false,
        },
        { onConflict: 'user_id,article_id' }
      );

      setReadArticles(prev => new Set(prev).add(article.id));
    } catch (error) {
      console.error('Error tracking article view:', error);
    }
  };

  const logReadingTime = async (article: Article) => {
    const timeSpent = Math.floor((Date.now() - articleStartTimeRef.current) / 1000);
    if (timeSpent < 5) return;

    try {
      await supabase.from('lectures_articles').upsert(
        {
          user_id: userId,
          article_id: article.id,
          temps_lecture_secondes: timeSpent,
          complete: timeSpent > 30,
          pourcentage_lu: 100,
        },
        { onConflict: 'user_id,article_id' }
      );
    } catch (error) {
      console.error('Error logging reading time:', error);
    }
  };

  const progress =
    articles.length > 0
      ? ((currentIndex + articleProgress / 100) / articles.length) * 100
      : 0;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < articles.length - 1;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-14 w-14 rounded-full border-4 border-[#d7deec] border-t-[#1f3b63] animate-spin" />
          <p className="text-[#1f3b63] text-sm sm:text-base font-medium">Chargement des articles...</p>
        </div>
      </div>
    );
  }

  if (articles.length === 0) {
    return (
      <div className="min-h-screen bg-[#f1f2f6] flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-[#dfe5f2] shadow-xl rounded-3xl px-8 py-10 text-center">
          <FileText className="w-16 h-16 text-[#94a3c0] mx-auto mb-6" />
          <h2 className="text-xl font-semibold text-[#1f3b63] mb-2">Aucun article disponible</h2>
          <p className="text-sm text-[#60719d] mb-6">
            Cette edition n'a pas encore ete traitee pour l'extraction d'articles.
          </p>
          <button
            onClick={onBackToPDF}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] font-medium shadow-sm hover:shadow transition"
          >
            <ArrowLeft className="w-4 h-4" />
            Retour au PDF
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[#f1f2f6] text-[#1f3b63]">
      <header className="sticky top-0 left-0 right-0 z-40 bg-white/95 border-b border-[#dfe5f2] shadow-sm backdrop-blur">
        <div className="max-w-4xl mx-auto h-14 sm:h-16 px-4 lg:px-6 flex items-center justify-between">
          <div className="flex items-center gap-3 lg:gap-4">
            <button
              onClick={onBackToPDF}
              className="h-10 w-10 rounded-full border border-[#d7deec] bg-white text-[#1f3b63] flex items-center justify-center shadow-sm hover:shadow-md transition hover:-translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#1f3b63]"
              title="Retour au PDF"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-3 min-w-0">
              <span className="inline-flex px-3 py-1 rounded-full border border-[#d0d8e8] bg-white text-[#1f3b63] font-semibold text-xs sm:text-sm uppercase tracking-[0.18em]">
                L ENQUETEUR
              </span>
              {editionLabel && (
                <span className="text-sm sm:text-base font-medium text-[#1f3b63] truncate">
                  {editionLabel}
                </span>
              )}
              {articles.length > 0 && (
                <span className="sm:hidden text-[11px] font-semibold text-[#60719d] uppercase tracking-wide">
                  Article {currentIndex + 1} / {articles.length}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm font-medium flex-wrap justify-end">
            <div className="hidden sm:flex items-center gap-2 text-[#1f3b63]">
              <BookOpen className="w-4 h-4" />
              <span>
                Article {currentIndex + 1} / {articles.length}
              </span>
            </div>
            <span className="text-[#60719d]">
              {readArticles.size}/{articles.length} lus
            </span>
          </div>
        </div>
        <div className="h-1 bg-[#e2e7f3]">
          <div
            className="h-full bg-[#1f3b63] transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {hasPrevious && (
        <button
          type="button"
          onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
          className="hidden lg:flex fixed left-6 top-1/2 -translate-y-1/2 z-30 flex-col items-center gap-1 px-3 py-4 rounded-full bg-white border border-[#d7deec] text-[#1f3b63] shadow-lg hover:-translate-x-1 hover:shadow-xl transition disabled:opacity-40 disabled:hover:translate-x-0"
          disabled={!hasPrevious}
        >
          <ChevronLeft className="w-5 h-5" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
            Art. {currentIndex}
          </span>
        </button>
      )}

      {hasNext && (
        <button
          type="button"
          onClick={() => setCurrentIndex(i => Math.min(articles.length - 1, i + 1))}
          className="hidden lg:flex fixed right-6 top-1/2 -translate-y-1/2 z-30 flex-col items-center gap-1 px-3 py-4 rounded-full bg-white border border-[#d7deec] text-[#1f3b63] shadow-lg hover:translate-x-1 hover:shadow-xl transition disabled:opacity-40 disabled:hover:translate-x-0"
          disabled={!hasNext}
        >
          <ChevronRight className="w-5 h-5" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#60719d]">
            Art. {currentIndex + 2}
          </span>
        </button>
      )}

      <main className="pt-20 sm:pt-24 pb-32 sm:pb-24 px-4">
        <div className="max-w-4xl mx-auto space-y-10">
          <article
            ref={articleContentRef}
            className="bg-white border border-[#dfe5f2] shadow-xl rounded-3xl px-5 sm:px-10 py-8 sm:py-14"
          >
            <div className="flex flex-col gap-6 border-b border-[#e2e7f3] pb-6">
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-[#0f1f40] leading-tight tracking-tight">
                    {currentArticle.titre}
                  </h1>
                  {currentArticle.sous_titre && (
                    <h2 className="text-lg sm:text-xl md:text-2xl text-[#3a4c73] mt-4 leading-relaxed font-medium italic">
                      {currentArticle.sous_titre}
                    </h2>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs sm:text-sm text-[#56658b]">
                {currentArticle.auteur && (
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-[#1f3b63] text-white flex items-center justify-center text-sm font-semibold">
                      {currentArticle.auteur.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[#94a3c0]">Par</p>
                      <p className="font-medium text-[#1f3b63]">{currentArticle.auteur}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#1f3b63]" />
                  <span className="font-medium text-[#1f3b63]">
                    {Math.ceil(currentArticle.temps_lecture_estime / 60)} min de lecture
                  </span>
                </div>

                {currentArticle.extraction_method === 'textract' && (
                  <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#cfe0f7] bg-[#eef4ff] text-[#1f3b63] font-semibold text-xs uppercase tracking-wide">
                    Extraction IA
                  </span>
                )}
              </div>
            </div>

            <div
              className="mt-8 text-[#30436b] leading-relaxed space-y-6 text-base sm:text-lg"
              style={{
                lineHeight: 1.8,
                letterSpacing: '0.01em',
              }}
            >
              {currentArticle.contenu_texte.split('\n\n').map((paragraph, index) => (
                <p
                  key={index}
                  className="mb-6 first:first-letter:text-5xl first:first-letter:font-bold first:first-letter:text-[#1f3b63] first:first-letter:mr-3 first:first-letter:float-left first:first-letter:leading-[0.8]"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </article>

          <div className="bg-white border border-[#dfe5f2] shadow-md rounded-2xl px-6 py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-sm text-[#60719d]">
            <div className="flex items-center gap-2 font-semibold text-[#1f3b63]">
              <BookOpen className="w-4 h-4" />
              <span>Lecture securisee</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:justify-end text-xs sm:text-sm font-mono">
              <span>{userName}</span>
              <span className="opacity-40">-</span>
              <span>{userNumber}</span>
              <span className="opacity-40">-</span>
              <span>{sessionId.substring(0, 8).toUpperCase()}</span>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        @media print {
          * { display: none !important; }
        }

        * {
          user-select: none !important;
          -webkit-user-select: none !important;
        }
      `}</style>
    </div>
  );
}
