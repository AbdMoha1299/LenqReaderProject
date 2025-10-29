import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Loader2,
  PenSquare,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from '../lib/supabase';
import type { Article, Edition, Page } from '../lib/supabase';

GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface ArticleZoneEditorProps {
  editionId: string;
  onClose: (refresh?: boolean) => void;
}

interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type FormMode = 'create' | 'edit';

interface FormState {
  mode: FormMode;
  article: Article | null;
  rect: NormalizedRect;
  titre: string;
  sousTitre: string;
  auteur: string;
  categorie: string;
  contenu: string;
  ordreLecture: number;
}

const MIN_RECT_SIZE = 0.01;

const clamp01 = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const wordsCount = (text: string) => {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
};

const toRect = (article: Article): NormalizedRect => ({
  x: article.position_x,
  y: article.position_y,
  width: article.width,
  height: article.height,
});

export function ArticleZoneEditor({ editionId, onClose }: ArticleZoneEditorProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [edition, setEdition] = useState<Edition | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [drawOrigin, setDrawOrigin] = useState<NormalizedRect | null>(null);
  const [draftRect, setDraftRect] = useState<NormalizedRect | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfSignedUrl, setPdfSignedUrl] = useState<string | null>(null);
  const [renderingPage, setRenderingPage] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState<{ width: number; height: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const { data: editionData, error: editionError } = await supabase
          .from('editions')
          .select('*')
          .eq('id', editionId)
          .single();

        if (editionError) throw editionError;
        setEdition(editionData);

        let loadedPdf: PDFDocumentProxy | null = null;
        let resolvedPdfUrl: string | null = null;
        const rawPdfUrl = editionData?.pdf_url || '';

        if (rawPdfUrl) {
          const isDirectUrl = /^https?:\/\//i.test(rawPdfUrl);
          if (isDirectUrl) {
            resolvedPdfUrl = rawPdfUrl;
          } else {
            const { data: signed, error: signedError } = await supabase.storage
              .from('secure-pdfs')
              .createSignedUrl(rawPdfUrl, 60 * 60);

            if (!signedError && signed?.signedUrl) {
              resolvedPdfUrl = signed.signedUrl;
            } else {
              const {
                data: { publicUrl },
              } = supabase.storage.from('secure-pdfs').getPublicUrl(rawPdfUrl);
              resolvedPdfUrl = publicUrl;
            }
          }
        }

        if (resolvedPdfUrl) {
          try {
            const task = getDocument(resolvedPdfUrl);
            loadedPdf = await task.promise;
            setPdfDoc(loadedPdf);
            setPdfSignedUrl(resolvedPdfUrl);
          } catch (pdfError) {
            console.error('Failed to load PDF for annotation', pdfError);
            setErrorMessage("Impossible de charger le PDF pour l'annotation.");
            setPdfDoc(null);
            setPdfSignedUrl(null);
          }
        } else {
          setPdfDoc(null);
          setPdfSignedUrl(null);
        }

        const { data: pagesData, error: pagesError } = await supabase
          .from('pages')
          .select('*')
          .eq('edition_id', editionId)
          .order('page_number', { ascending: true });

        if (pagesError) throw pagesError;

        let resolvedPages = pagesData || [];

        if (loadedPdf && resolvedPages.length === 0) {
          const inserts = Array.from({ length: loadedPdf.numPages }, (_, index) => ({
            edition_id: editionId,
            page_number: index + 1,
          }));

          if (inserts.length > 0) {
            const { error: insertError } = await supabase.from('pages').insert(inserts);
            if (insertError) {
              console.error('Failed to create pages records', insertError);
            } else {
              await supabase
                .from('editions')
                .update({ nb_pages: loadedPdf.numPages })
                .eq('id', editionId);

              const { data: refreshedPages, error: refreshedError } = await supabase
                .from('pages')
                .select('*')
                .eq('edition_id', editionId)
                .order('page_number', { ascending: true });

              if (!refreshedError) {
                resolvedPages = refreshedPages || [];
              }
            }
          }
        }

        setPages(resolvedPages);
        if (!selectedPageId && resolvedPages.length > 0) {
          setSelectedPageId(resolvedPages[0].id);
        }

        const { data: articlesData, error: articlesError } = await supabase
          .from('articles')
          .select('*')
          .eq('edition_id', editionId)
          .order('ordre_lecture', { ascending: true });

        if (articlesError) throw articlesError;
        setArticles(articlesData || []);
      } catch (error) {
        console.error('Failed to load edition data', error);
        setErrorMessage(
          "Impossible de charger les donnees de l'edition. Verifiez que le PDF est accessible."
        );
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [editionId]);

  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) || null,
    [pages, selectedPageId]
  );

  const pageArticles = useMemo(
    () => articles.filter((article) => article.page_id === selectedPageId),
    [articles, selectedPageId]
  );

  useEffect(() => {
    if (!pdfDoc || !selectedPage || !pdfCanvasRef.current) return;

    let cancelled = false;

    const renderPage = async () => {
      setRenderingPage(true);
      try {
        const page = await pdfDoc.getPage(selectedPage.page_number);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = pdfCanvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        setCanvasDimensions({ width: viewport.width, height: viewport.height });

        context.clearRect(0, 0, canvas.width, canvas.height);
        const renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (error) {
        console.error('Failed to render PDF page', error);
      } finally {
        if (!cancelled) {
          setRenderingPage(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, selectedPage]);

  const maxOrdreLecture = useMemo(
    () =>
      articles.reduce((acc, article) => Math.max(acc, article.ordre_lecture || 0), 0),
    [articles]
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const allowRedraw = formState?.mode === 'edit';
    if (!selectedPage || saving || !pdfDoc) return;
    if (formState && !allowRedraw) return;

    const bounds = pdfCanvasRef.current?.getBoundingClientRect();
    if (!bounds) return;

    event.preventDefault();

    const pointerX = clamp01((event.clientX - bounds.left) / bounds.width);
    const pointerY = clamp01((event.clientY - bounds.top) / bounds.height);

    const originRect: NormalizedRect = { x: pointerX, y: pointerY, width: 0, height: 0 };
    setDrawOrigin(originRect);
    setDraftRect(originRect);

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawOrigin || !pdfCanvasRef.current) return;
    const bounds = pdfCanvasRef.current.getBoundingClientRect();
    if (!bounds) return;
    const currentX = clamp01((event.clientX - bounds.left) / bounds.width);
    const currentY = clamp01((event.clientY - bounds.top) / bounds.height);

    const rectX = Math.min(drawOrigin.x, currentX);
    const rectY = Math.min(drawOrigin.y, currentY);
    const rectWidth = Math.abs(currentX - drawOrigin.x);
    const rectHeight = Math.abs(currentY - drawOrigin.y);

    setDraftRect({
      x: rectX,
      y: rectY,
      width: rectWidth,
      height: rectHeight,
    });
  };

  const finalizeDraftRect = () => {
    if (!draftRect || draftRect.width < MIN_RECT_SIZE || draftRect.height < MIN_RECT_SIZE) {
      setDraftRect(null);
      setDrawOrigin(null);
      return;
    }

    if (formState?.mode === 'edit') {
      setFormState((prev) => (prev ? { ...prev, rect: draftRect } : prev));
      setDraftRect(null);
      setDrawOrigin(null);
      return;
    }

    openForm('create', draftRect, null);
    setDraftRect(null);
    setDrawOrigin(null);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawOrigin) return;
    finalizeDraftRect();
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (!drawOrigin) return;
    finalizeDraftRect();
  };

  const getNextOrder = () => maxOrdreLecture + 1;

  const openForm = (mode: FormMode, rect: NormalizedRect, article: Article | null) => {
    setFormState({
      mode,
      article,
      rect,
      titre: article?.titre || '',
      sousTitre: article?.sous_titre || '',
      auteur: article?.auteur || '',
      categorie: article?.categorie || '',
      contenu: article?.contenu_texte || '',
      ordreLecture: article?.ordre_lecture || getNextOrder(),
    });
  };

  const handleEditArticle = (article: Article) => {
    setSelectedPageId(article.page_id);
    openForm('edit', toRect(article), article);
  };

  const handleDeleteArticle = async () => {
    if (!formState?.article) return;
    if (!window.confirm('Supprimer definitivement cet article ?')) return;

    setSaving(true);
    try {
      const { error } = await supabase.from('articles').delete().eq('id', formState.article.id);
      if (error) throw error;

      setArticles((prev) => prev.filter((item) => item.id !== formState.article?.id));
      setFormState(null);
      setHasChanges(true);
    } catch (error) {
      console.error('Failed to delete article', error);
      setErrorMessage("Impossible de supprimer l'article pour le moment.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveForm = async () => {
    if (!formState || !selectedPageId) return;

    const { rect, article, mode, titre, sousTitre, auteur, categorie, contenu, ordreLecture } =
      formState;

    if (!titre.trim() || !contenu.trim()) {
      setErrorMessage('Le titre et le contenu sont obligatoires.');
      return;
    }

    setSaving(true);
    setErrorMessage(null);

    const motCount = wordsCount(contenu);
    const readingSeconds = Math.max(60, Math.round((motCount / 200) * 60));

    const payload = {
      titre: titre.trim(),
      sous_titre: sousTitre.trim() || null,
      auteur: auteur.trim() || null,
      categorie: categorie.trim() || null,
      contenu_texte: contenu.trim(),
      position_x: rect.x,
      position_y: rect.y,
      width: rect.width,
      height: rect.height,
      ordre_lecture: ordreLecture,
      mots_count: motCount,
      temps_lecture_estime: readingSeconds,
      confidence_score: 1,
      extraction_method: 'manual' as const,
      ajuste_manuellement: true,
      valide: true,
    };

    try {
      if (mode === 'create') {
        const { data, error } = await supabase
          .from('articles')
          .insert({
            ...payload,
            edition_id: editionId,
            page_id: selectedPageId,
          })
          .select()
          .single();

        if (error) throw error;
        setArticles((prev) => [...prev, data]);
      } else if (article) {
        const { data, error } = await supabase
          .from('articles')
          .update({
            ...payload,
            page_id: article.page_id,
          })
          .eq('id', article.id)
          .select()
          .single();

        if (error) throw error;

        setArticles((prev) => prev.map((item) => (item.id === data.id ? data : item)));
      }

      setFormState(null);
      setHasChanges(true);
    } catch (error) {
      console.error('Failed to save article', error);
      setErrorMessage("Impossible d'enregistrer l'article pour le moment.");
    } finally {
      setSaving(false);
    }
  };

  const movePage = (direction: 'prev' | 'next') => {
    if (!selectedPage) return;
    const currentIndex = pages.findIndex((page) => page.id === selectedPage.id);
    const nextIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= pages.length) return;
    setSelectedPageId(pages[nextIndex].id);
  };

  const closeEditor = () => {
    onClose(hasChanges);
  };

  const handleConfirmAnnotations = async () => {
    if (confirming) return;
    if (!confirm("Confirmer l'annotation de cette edition ?")) return;

    setConfirming(true);
    try {
      const { error } = await supabase
        .from('editions')
        .update({ statut: 'ready' })
        .eq('id', editionId);

      if (error) throw error;

      setHasChanges(false);
      onClose(true);
    } catch (error) {
      console.error('Failed to confirm edition annotations', error);
      setErrorMessage("Impossible de confirmer l'edition pour le moment.");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="flex h-full w-full max-w-7xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-white">
              {edition?.titre || 'Annotation des articles'}
            </h2>
            <p className="text-sm text-slate-400">
              Dessinez des zones sur chaque page puis associez le contenu correspondant avant de confirmer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleConfirmAnnotations}
              disabled={confirming}
              className="flex items-center gap-2 rounded-lg border border-emerald-600 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {confirming ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Confirmation...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4" />
                  Confirmer l'annotation
                </>
              )}
            </button>
            <button
              onClick={closeEditor}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-300 transition hover:bg-slate-700 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {errorMessage && (
          <div className="mx-6 mt-4 rounded-lg border border-red-900 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-300" />
              <span>{errorMessage}</span>
            </div>
          </div>
        )}

        <div className="flex flex-1 flex-col gap-6 overflow-hidden p-6 lg:flex-row">
          <div className="flex flex-1 flex-col gap-4 overflow-hidden">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-300">
                  Page {selectedPage ? selectedPage.page_number : '--'} / {pages.length}
                </span>
                <button
                  onClick={() => movePage('prev')}
                  disabled={!selectedPage || pages.length === 0 || pages[0].id === selectedPageId}
                  className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:border-amber-500 hover:text-amber-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Precedente
                </button>
                <button
                  onClick={() => movePage('next')}
                  disabled={
                    !selectedPage ||
                    pages.length === 0 ||
                    pages[pages.length - 1].id === selectedPageId
                  }
                  className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:border-amber-500 hover:text-amber-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600"
                >
                  Suivante
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <PenSquare className="h-5 w-5 text-amber-400" />
                <span className="text-sm text-slate-400">
                  Astuce : cliquez-glissez pour creer une zone.
                </span>
              </div>
            </div>

            <div className="relative flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
              {loading ? (
                <div className="flex h-full items-center justify-center text-slate-400">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Chargement des pages...
                </div>
              ) : !selectedPage ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
                  Aucune page disponible. Verifiez que le PDF a bien ete prepare.
                </div>
              ) : (
                <div
                  ref={canvasRef}
                  className="relative flex h-full items-center justify-center bg-slate-900"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  style={{
                    touchAction: 'none',
                    aspectRatio: canvasDimensions
                      ? `${canvasDimensions.width}/${canvasDimensions.height || 1}`
                      : undefined,
                  }}
                >
                  <canvas
                    ref={pdfCanvasRef}
                    className="h-full w-full select-none"
                    style={{
                      visibility: renderingPage ? 'hidden' : 'visible',
                    }}
                  />

                  {renderingPage && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 text-slate-200">
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Rendu de la page...
                    </div>
                  )}

                  {!pdfSignedUrl && !renderingPage && (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-slate-500">
                      PDF introuvable ou non charge.
                    </div>
                  )}

                  {pageArticles.map((article) => (
                    <button
                      key={article.id}
                      type="button"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        handleEditArticle(article);
                      }}
                      style={{
                        left: `${article.position_x * 100}%`,
                        top: `${article.position_y * 100}%`,
                        width: `${article.width * 100}%`,
                        height: `${article.height * 100}%`,
                      }}
                      className="absolute rounded border-2 border-transparent bg-transparent transition hover:border-amber-400 hover:bg-amber-500/20"
                      title={article.titre}
                    >
                      <span className="sr-only">{article.titre}</span>
                    </button>
                  ))}

                  {draftRect && (
                    <div
                      className="absolute border-2 border-dashed border-amber-400 bg-amber-500/20"
                      style={{
                        left: `${draftRect.x * 100}%`,
                        top: `${draftRect.y * 100}%`,
                        width: `${draftRect.width * 100}%`,
                        height: `${draftRect.height * 100}%`,
                      }}
                    />
                  )}

                  {formState && (
                    <div
                      className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/10"
                      style={{
                        left: `${formState.rect.x * 100}%`,
                        top: `${formState.rect.y * 100}%`,
                        width: `${formState.rect.width * 100}%`,
                        height: `${formState.rect.height * 100}%`,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex w-full flex-col gap-4 overflow-y-auto lg:w-96">
            {formState ? (
              <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
                    <PenSquare className="h-5 w-5 text-amber-400" />
                    {formState.mode === 'create' ? 'Nouvel article' : "Modifier l'article"}
                  </h3>
                  <button
                    onClick={() => setFormState(null)}
                    className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-400 transition hover:border-slate-500 hover:text-white"
                  >
                    Annuler
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                      Titre
                    </label>
                    <input
                      type="text"
                      value={formState.titre}
                      onChange={(event) =>
                        setFormState((prev) =>
                          prev ? { ...prev, titre: event.target.value } : prev
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                      placeholder="Titre de l'article"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                      Sous-titre
                    </label>
                    <input
                      type="text"
                      value={formState.sousTitre}
                      onChange={(event) =>
                        setFormState((prev) =>
                          prev ? { ...prev, sousTitre: event.target.value } : prev
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                      placeholder="Sous-titre (optionnel)"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                        Auteur
                      </label>
                      <input
                        type="text"
                        value={formState.auteur}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev ? { ...prev, auteur: event.target.value } : prev
                          )
                        }
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                        placeholder="Nom de l'auteur"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                        Categorie
                      </label>
                      <input
                        type="text"
                        value={formState.categorie}
                        onChange={(event) =>
                          setFormState((prev) =>
                            prev ? { ...prev, categorie: event.target.value } : prev
                          )
                        }
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                        placeholder="Politique, Sport, Societe..."
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                      Contenu de l'article
                    </label>
                    <textarea
                      value={formState.contenu}
                      onChange={(event) =>
                        setFormState((prev) =>
                          prev ? { ...prev, contenu: event.target.value } : prev
                        )
                      }
                      rows={6}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                      placeholder="Copiez ou saisissez le texte de l'article..."
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase text-slate-400">
                      Ordre de lecture
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={formState.ordreLecture}
                      onChange={(event) =>
                        setFormState((prev) =>
                          prev
                            ? { ...prev, ordreLecture: Number(event.target.value) || 1 }
                            : prev
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500"
                    />
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
                    <p>
                      Zone :{' '}
                      <span className="font-medium text-slate-300">
                        {(formState.rect.x * 100).toFixed(1)}% /{' '}
                        {(formState.rect.y * 100).toFixed(1)}% - taille{' '}
                        {(formState.rect.width * 100).toFixed(1)}% x{' '}
                        {(formState.rect.height * 100).toFixed(1)}%
                      </span>
                    </p>
                    <p className="mt-1">
                      Mots estimes :{' '}
                      <span className="font-medium text-slate-300">
                        {wordsCount(formState.contenu)}
                      </span>
                    </p>
                    {formState.mode === 'edit' && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        Tracez une nouvelle zone sur la page pour ajuster la position.
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  {formState.mode === 'edit' ? (
                    <button
                      onClick={handleDeleteArticle}
                      disabled={saving}
                      className="flex items-center gap-2 rounded-lg border border-red-900 px-3 py-2 text-sm font-medium text-red-300 transition hover:bg-red-900/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" />
                      Supprimer
                    </button>
                  ) : (
                    <span />
                  )}

                  <button
                    onClick={handleSaveForm}
                    disabled={saving}
                    className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-semibold text-black transition hover:from-amber-600 hover:to-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Enregistrement...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        Enregistrer
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-5 text-sm text-slate-300">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-400" />
                  <div className="space-y-2">
                    <p className="font-medium text-white">
                      Dessinez une zone sur la page pour creer un nouvel article.
                    </p>
                    <ul className="space-y-1 text-slate-400">
                      <li>- Cliquez-glissez pour definir la zone de l'article.</li>
                      <li>- Cliquez sur une zone existante pour modifier texte et position.</li>
                      <li>- L'ordre de lecture impacte l'affichage dans la liseuse.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Articles sur cette page ({pageArticles.length})
              </h3>

              {pageArticles.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Aucun article n'est associe a cette page pour le moment.
                </p>
              ) : (
                <div className="space-y-2">
                  {pageArticles
                    .slice()
                    .sort((a, b) => (a.ordre_lecture || 0) - (b.ordre_lecture || 0))
                    .map((article) => (
                      <button
                        key={article.id}
                        type="button"
                        onClick={() => handleEditArticle(article)}
                        className="flex w-full flex-col rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-left transition hover:border-amber-500/80 hover:bg-amber-500/10"
                      >
                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <span>Ordre {article.ordre_lecture}</span>
                          <span>
                            {(article.width * 100).toFixed(1)}% x {(article.height * 100).toFixed(1)}%
                          </span>
                        </div>
                        <span className="mt-1 text-sm font-semibold text-white">
                          {article.titre}
                        </span>
                        {article.auteur && (
                          <span className="text-xs text-slate-400">{article.auteur}</span>
                        )}
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Autres pages
              </h3>
              <div className="grid grid-cols-3 gap-2 text-xs text-slate-300">
                {pages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setSelectedPageId(page.id)}
                    className={`rounded-lg border px-2 py-2 transition ${
                      page.id === selectedPageId
                        ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                        : 'border-slate-700 bg-slate-900 hover:border-amber-500/60'
                    }`}
                  >
                    Page {page.page_number}
                    <div className="mt-1 text-[10px] text-slate-500">
                      {articles.filter((article) => article.page_id === page.id).length} article(s)
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
