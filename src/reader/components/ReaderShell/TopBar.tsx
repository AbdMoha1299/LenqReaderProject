import { X, Minus, Plus, BookOpen } from 'lucide-react';
import { useReaderController } from '../../hooks/useReaderController';
import { useReaderManifest, useReaderState } from '../../contexts/ReaderContext';

interface TopBarProps {
  onExit: () => void;
  onOpenArticleList?: () => void;
}

export const TopBar = ({ onExit, onOpenArticleList }: TopBarProps) => {
  const state = useReaderState();
  const { setZoom } = useReaderController();
  const manifest = useReaderManifest();

  const increaseZoom = () => setZoom(state.zoom + 0.1);
  const decreaseZoom = () => setZoom(state.zoom - 0.1);

  return (
    <header className="z-30 flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[#dfe5f2] bg-white/90 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-2 rounded-full border border-[#dfe5f2] px-3 py-2 text-sm font-medium text-[#1f3b63] shadow-sm hover:bg-[#f3f6fb] transition"
        >
          <X className="w-4 h-4" />
          Quitter
        </button>
        <div className="hidden sm:flex flex-col">
          <span className="text-xs uppercase tracking-wide text-[#60719d]">Edition</span>
          <span className="text-sm font-semibold text-[#1f3b63]">
            {manifest.edition.title}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden sm:flex items-center gap-2 rounded-full border border-[#dfe5f2] bg-white px-2 py-1">
          <button
            type="button"
            onClick={decreaseZoom}
            className="p-2 rounded-full hover:bg-[#f3f6fb] transition"
            title="Zoom -"
          >
            <Minus className="w-4 h-4 text-[#1f3b63]" />
          </button>
          <span className="text-xs font-semibold text-[#1f3b63] min-w-[48px] text-center">
            {(state.zoom * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            onClick={increaseZoom}
            className="p-2 rounded-full hover:bg-[#f3f6fb] transition"
            title="Zoom +"
          >
            <Plus className="w-4 h-4 text-[#1f3b63]" />
          </button>
        </div>

        {onOpenArticleList && (
          <button
            type="button"
            onClick={onOpenArticleList}
            className="flex items-center gap-2 rounded-full border border-[#dfe5f2] px-3 py-2 text-sm font-medium text-[#1f3b63] shadow-sm hover:bg-[#f3f6fb] transition"
          >
            <BookOpen className="w-4 h-4" />
            Sommaire
          </button>
        )}
      </div>
    </header>
  );
};

