import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useReaderController } from '../../hooks/useReaderController';
import { useReaderState } from '../../contexts/ReaderContext';

export const BottomBar = () => {
  const state = useReaderState();
  const { goToNextPage, goToPreviousPage } = useReaderController();

  const progress = useMemo(() => {
    if (!state.totalPages) return 0;
    return (state.currentPage / state.totalPages) * 100;
  }, [state.currentPage, state.totalPages]);

  return (
    <footer className="z-30 flex flex-col gap-2 px-4 sm:px-6 py-3 border-t border-[#dfe5f2] bg-white/90 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#60719d] uppercase tracking-wide">
          <span>Page {state.currentPage}</span>
          <span className="opacity-50">/</span>
          <span>{state.totalPages}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goToPreviousPage}
            disabled={state.currentPage <= 1}
            className="flex items-center gap-2 rounded-full border border-[#dfe5f2] px-3 py-2 text-sm font-medium text-[#1f3b63] hover:bg-[#f3f6fb] transition disabled:opacity-40 disabled:hover:bg-white"
          >
            <ChevronLeft className="w-4 h-4" />
            Précédente
          </button>
          <button
            type="button"
            onClick={goToNextPage}
            disabled={state.currentPage >= state.totalPages}
            className="flex items-center gap-2 rounded-full border border-[#dfe5f2] px-3 py-2 text-sm font-medium text-[#1f3b63] hover:bg-[#f3f6fb] transition disabled:opacity-40 disabled:hover:bg-white"
          >
            Suivante
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="h-2 w-full rounded-full bg-[#eef2fa] overflow-hidden">
        <div
          className="h-full rounded-full bg-[#163860] transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </footer>
  );
};
