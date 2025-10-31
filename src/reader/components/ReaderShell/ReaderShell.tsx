import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useReaderAccess, useReaderManifest, useReaderState } from '../../contexts/ReaderContext';
import { useReaderController } from '../../hooks/useReaderController';
import { PageViewport } from '../PageViewport/PageViewport';
import { HotspotOverlay } from '../HotspotOverlay/HotspotOverlay';
import { TopBar } from './TopBar';
import { BottomBar } from './BottomBar';
import { ArticleReader } from '../../../components/ArticleReader';

interface ReaderShellProps {
  onExit: () => void;
}

export const ReaderShell = ({ onExit }: ReaderShellProps) => {
  const state = useReaderState();
  const manifest = useReaderManifest();
  const controller = useReaderController();
  const access = useReaderAccess();
  const [articleInitialId, setArticleInitialId] = useState<string | null>(null);

  const currentPageData = useMemo(
    () => manifest.pages[state.currentPage - 1] ?? null,
    [manifest.pages, state.currentPage]
  );

  useEffect(() => {
    if (state.mode === 'article' && state.activeArticleId) {
      setArticleInitialId(state.activeArticleId);
    }
  }, [state.activeArticleId, state.mode]);

  const handleBackToPdf = useCallback(() => {
    controller.exitArticleMode();
  }, [controller]);

  return (
    <div className="relative flex h-full min-h-screen flex-col bg-[#f4f6fb]">
      <TopBar onExit={onExit} />

      <div className="relative flex-1">
        <PageViewport />
        <HotspotOverlay disabled={state.mode !== 'page'} />
      </div>

      <BottomBar />

      <AnimatePresence>
        {state.mode === 'article' && articleInitialId && (
          <motion.div
            className="fixed inset-0 z-40 bg-[#0f172a]/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-x-0 bottom-0 top-16 rounded-t-3xl bg-[#eff3fb] shadow-2xl overflow-hidden"
              initial={{ translateY: '100%' }}
              animate={{ translateY: 0 }}
              exit={{ translateY: '100%' }}
              transition={{ type: 'spring', stiffness: 220, damping: 26 }}
            >
              <ArticleReader
                editionId={access.accessData.editionId}
                userId={access.accessData.userId}
                userName={access.accessData.userName ?? ''}
                userNumber={access.accessData.userNumber ?? ''}
                sessionId={access.accessData.sessionId}
                onBackToPDF={handleBackToPdf}
                initialArticleId={articleInitialId}
                editionLabel={manifest.edition.title}
                onArticleChange={(articleId) => setArticleInitialId(articleId)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-none fixed inset-x-0 top-[72px] z-20 flex items-center justify-center">
        <div className="pointer-events-auto inline-flex items-center gap-3 rounded-full border border-[#dfe5f2] bg-white px-4 py-2 shadow-md">
          <span className="text-xs font-semibold uppercase tracking-wide text-[#60719d]">
            Page {state.currentPage}/{state.totalPages}
          </span>
          {currentPageData?.hotspots.length ? (
            <span className="flex items-center gap-2 rounded-full bg-[#163860]/10 px-3 py-1 text-xs font-semibold text-[#163860]">
              {currentPageData.hotspots.length} article(s)
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};
