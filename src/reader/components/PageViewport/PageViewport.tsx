import { memo, useMemo } from 'react';
import { useReaderManifest, useReaderState } from '../../contexts/ReaderContext';

interface PageViewportProps {
  onImageLoad?: () => void;
}

const PageViewportComponent = ({ onImageLoad }: PageViewportProps) => {
  const manifest = useReaderManifest();
  const state = useReaderState();

  const page = useMemo(
    () => manifest.pages[state.currentPage - 1] ?? null,
    [manifest.pages, state.currentPage]
  );

  if (!page) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full text-[#1f3b63]">
        <p className="text-sm font-medium opacity-70">Page introuvable</p>
      </div>
    );
  }

  return (
    <div className="relative flex items-center justify-center w-full h-full overflow-hidden bg-[#f1f4f9]">
      <div className="relative max-h-full max-w-full">
        <img
          src={page.lowResImageUrl}
          alt={`Page ${page.pageNumber}`}
          className="block max-h-[calc(100vh-160px)] max-w-full rounded-xl shadow-lg border border-[#dfe5f2] bg-white"
          style={{
            objectFit: 'contain',
          }}
          onLoad={onImageLoad}
        />
      </div>
    </div>
  );
};

export const PageViewport = memo(PageViewportComponent);

