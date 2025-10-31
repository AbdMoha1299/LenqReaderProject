import { memo, useMemo } from 'react';
import { useReaderController } from '../../hooks/useReaderController';
import { useReaderManifest, useReaderState } from '../../contexts/ReaderContext';
import type { ReaderHotspot } from '../../types';

interface HotspotOverlayProps {
  disabled?: boolean;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const HotspotOverlayComponent = ({ disabled }: HotspotOverlayProps) => {
  const manifest = useReaderManifest();
  const state = useReaderState();
  const controller = useReaderController();

  const hotspots = useMemo<ReaderHotspot[]>(() => {
    const page = manifest.pages[state.currentPage - 1];
    return page?.hotspots ?? [];
  }, [manifest.pages, state.currentPage]);

  if (disabled || hotspots.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="relative">
        {hotspots.map((hotspot) => {
          const left = clamp01(hotspot.x) * 100;
          const top = clamp01(hotspot.y) * 100;
          const width = clamp01(hotspot.width) * 100;
          const height = clamp01(hotspot.height) * 100;

          return (
            <button
              key={hotspot.id}
              type="button"
              className="pointer-events-auto absolute rounded-md border border-transparent bg-[#163860]/10 hover:bg-[#163860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#163860]"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
              }}
              title={hotspot.title}
              onClick={() => controller.enterArticleMode(hotspot.articleId)}
            >
              <span className="sr-only">{hotspot.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const HotspotOverlay = memo(HotspotOverlayComponent);

