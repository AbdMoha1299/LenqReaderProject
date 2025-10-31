# Modern Reader Re-Architecture (Milibris-Level Experience)

This document captures the end-to-end design for a next-generation reader inspired by Milibris. It spans the asset pipeline, Supabase services, front-end shell, and the tightening between page view, hotspots, and article mode.

---

## 1. Goals & Key Experiences

| Capability | Current status | Target behaviour |
| --- | --- | --- |
| **Ultra-fast page load** | PDF.js renders directly in canvas | Stream low-res preview instantly, then swap in sharp tiles |
| **Smooth navigation** | Single canvas refresh; basic buttons | Continuous scroll or swipe, with inertial gestures, flatplan, progress bar, bottom filters |
| **Article focus** | Article mode exists but not deeply linked | Hotspots mapped to article metadata, instant transition to text view or summary |
| **High resiliency** | Render queue prevents crash, but still heavy on CPU | Tile loading per page, abortable fetches, caching, predictive prefetch |
| **Extensibility** | Monolithic component with entangled logic | Pluggable architecture: asset services, viewer contexts, UI modules, Supabase edge ready |

---

## 2. High-Level Architecture

```
                ┌──────────────────────────┐
                │   Supabase Edge Layer    │
                │                          │
 PDF Upload ──► │ 1. pdf-processing queue  │
                │ 2. tile generator fn     │
                │ 3. metadata writer fn    │
                └────────────┬─────────────┘
                             │
                     Tiles + JSON
                             │
                   ┌─────────▼─────────┐
                   │   Storage / CDN   │
                   │ (tiles, sprites)  │
                   └─────────┬─────────┘
                             │
                             │ signed URLs (short-lived)
                             │
              ┌──────────────▼────────────────┐
              │     Reader Web App (React)    │
              │                                │
              │ ┌─────────┐ ┌─────────┐ ┌────┐ │
              │ │Contexts │ │Services │ │UI  │ │
              │ └─────────┘ └─────────┘ └────┘ │
              │   | ReaderState  | TileCache   │
              │   | Document     | Hotspot API │
              │                                │
              │ ▸ PageViewport (tiles + anim)  │
              │ ▸ HotspotOverlay (articles)    │
              │ ▸ ArticlePane (text)           │
              │ ▸ Navigation (top/bottom bars) │
              │ ▸ Flatplan & Summary           │
              └────────────────────────────────┘
```

---

## 3. Asset & Metadata Pipeline

### 3.1 Upload Flow

1. **PDF Uploads** are already stored via Supabase Storage (secure bucket). On each upload:
   - emit queue message (via `pdf_processing_jobs` table or edge function webhook) with `pdf_id`, `storage_path`, `edition_id`.

2. **Edge Function `process-pdf` (Deno)** orchestrates:
   - PDF to PNG conversion (Ghostscript or Poppler via bundled binary) ⇒ target resolution (300 dpi baseline).
   - Generate multi-resolution JPEG/WEBP tiles using `sharp` or `geotiff` tiler pattern (256x256 blocks).
   - Upload into storage under: `public/editions/{editionId}/tiles/{page}/{level}/{tileX}x{tileY}.webp`.
   - Generate low-definition (ld) and thumbnail (tn) images per page.
   - Emit metadata manifest.

3. **Metadata writer** stores:
   - `page_assets` table: `edition_id`, `page_number`, `ld_url`, `levels`, `tile_matrix` dimensions, width/height, `sprite_key` (if using sprites).
   - `article_zones`: as already stored; ensure consistent normalization (x, y, width, height relative to page coordinates).
   - `edition_assets_manifest`: aggregated JSON with versioning for cache bust.

### 3.2 Storage Layout

```
public/editions/{editionId}/
  manifest.json                 # { pages: [...], createdAt, version }
  thumbnails/page-001.jpg
  lowdef/page-001.jpg
  tiles/level-0/page-001/tile-0-0.webp
  tiles/level-1/page-001/tile-0-0.webp
  ...
```

**Notes**
- Level-0 => base scale (fit width). Extra levels for zoom > 1.5x.
- Keep consistent file naming to allow deterministic URL generation.
- Use Supabase signed URLs with short TTL, generated via edge function `get-tile-url` if need secure gating.

---

## 4. Supabase Services

| Function | Purpose | Input | Output |
| --- | --- | --- | --- |
| `process-pdf` | Generate tiles & manifests | `{ pdfId }` | Trigger asset creation |
| `issue-reader-access` | Already in place for tokens | `{ token }` | Signed session info |
| `fetch-reader-manifest` | Provide manifest + article layout | `{ editionId, token }` | JSON (pages, tiles, hotspots) |
| `get-tile-url` | Optionally sign tile URL | `{ editionId, page, level, tile }` | `{ url, expiresAt }` |
| `track-reader-event` | Logging for analytics | various | ack |

**Database additions**

- `page_assets`: track resolution metadata per page.
- `edition_manifests`: store canonical manifest (versioned). Alternatively store JSON in existing `pages` table as `tile_manifest` to avoid extra table.
- `processing_jobs`: states for tile generation (queued, running, done, error).

---

## 5. Front-End Architecture

### 5.1 Top-Level Structure (React)

```
src/reader/
  contexts/
    ReaderProvider.tsx          # Reader state machine (mode, page, zoom, tokens)
    TileCacheProvider.tsx       # LRU cache for ImageBitmap/HTMLImageElement

  hooks/
    useReaderController.ts      # Imperative controls (next, prev, goTo)
    useTileLoader.ts            # Aborts/checks for tiles per viewport
    useHotspotData.ts           # Fetch + format article boxes
    useArticleContent.ts        # Lazy load article text/html
    useGestureBindings.ts       # Pointer/pinch/wheel gestures

  services/
    tileService.ts              # Build URLs, fetch tiles, decode
    manifestService.ts          # Fetch manifest from Supabase
    articleService.ts           # API for article metadata/content

  components/
    ReaderShell/
      ReaderShell.tsx           # Compose top/bottom bars and viewport
      TopBar.tsx
      BottomBar.tsx
      FlatplanDrawer.tsx
      SummaryModal.tsx

    PageViewport/
      PageViewport.tsx          # Canvas or absolutely positioned div with tiles
      TileLayer.tsx             # Manage image elements
      PageOverlay.tsx           # Render watermarks, safe zones
      CrossfadeCanvas.tsx       # optional double canvas for transitions

    HotspotOverlay/
      HotspotOverlay.tsx
      HotspotButton.tsx

    ArticlePane/
      ArticlePane.tsx
      ArticleSummary.tsx
      ArticleNavigator.tsx

    Shared/
      ZoomControls.tsx
      ProgressBar.tsx
      LoadingSkeleton.tsx
```

### 5.2 Reader State Machine

- `status`: `'loading' | 'ready' | 'error'`
- `mode`: `'page' | 'article' | 'summary'`
- `page`: `{ index: number, spread: boolean }`
- `zoom`: `{ level: number, center: { x, y } }`
- `rotation`
- `manifest`: { pages: PageManifest[], editionInfo }
- `hotspots`: Map<page, Hotspot[]>
- `article`: { activeId, pendingId, content }

**Reducers/Actions**
- `LOAD_MANIFEST_SUCCESS`, `SET_PAGE`, `SET_ZOOM`, `ENTER_ARTICLE_MODE`, `EXIT_ARTICLE_MODE`, `SET_ARTICLE_CONTENT`, etc.

### 5.3 Tile Loading Lifecycle

1. `PageViewport` obtains visible pages (single or spread) from context.
2. For each page:
   - Request LD background first (`<img>` with blur).
   - Kick off `useTileLoader` for visible tiles (based on level determined by zoom). This hook returns `tiles: TileDescriptor[]` with status (pending/ready).
   - When each tile resolves (ImageBitmap or Image), update `TileLayer` state to render it positioned absolutely (via CSS transforms).
3. On page/zoom changes:
   - Cancel outstanding fetches using `AbortController` managed by `useTileLoader` and `TileCacheProvider`.
   - Crossfade from old tile set to new by toggling CSS `opacity` on layered containers (double buffer).
4. Prefetch next/prev page tiles using `requestIdleCallback` or a background priority queue.

### 5.4 Hotspot Overlay

- Works with DOM elements positioned within same container as `TileLayer` so they respond to the same transform (scale/translate).
- Each hotspot button: `absolute`, but apply transform matrix from viewport (scale + translate) to keep alignment during zoom/pan.
- On click ⇒ dispatch `ENTER_ARTICLE_MODE` with `articleId`, fetch content via `articleService`, open `ArticlePane` as overlay slide-in (like summary table view). Provide a `Back to page` action.

### 5.5 Navigation & Auxiliary UI

| Component | Behaviour |
| --- | --- |
| **Top bar** | Buttons for exit, zoom -, zoom +, fullscreen, menu (settings). |
| **Bottom bar** | Tag filter chips (category), reading progress, quick access to summary. |
| **Flatplan Drawer** | Thumbnails of spreads, highlight current, click to navigate. |
| **ProgressBar** | Reflects page index / total. |
| **Floating Buttons** | Toggle summary, article list, search. |
| **Summary Modal** | Uses manifest to show article cards with quick jump. |

---

## 6. Edge Cases & Performance Considerations

1. **Offline/poor connection**: show low-def placeholder; degrade to single tile if hi-res fails.
2. **Device memory**: limit tile cache (LRU) by page-level, e.g., keep two spreads (current ±1). Release via `TileCacheProvider` when page changes or memory pressure event (`navigator.deviceMemory` or heuristics).
3. **Touch gestures**: apply pinch-to-zoom + pan using `pointermove` + `pointerup`. Synced to transform matrix; throttle events (`requestAnimationFrame`).
4. **Text selection**: optional overlay of hidden text layer (if using OCR). Initially skip; rely on article mode for accessible text.
5. **Watermarking**: draw dynamic overlays using CSS or canvas `mix-blend-mode` to avoid server-side modifications. If necessary, pre-render watermark tile layer in tile generator to prevent tampering.
6. **Security**: tiles behind signed URLs; short TTL (e.g. 5 minutes). Refresh tokens as part of `ReaderState` via background function.

---

## 7. Implementation Phases

### Phase 1 – Foundation
- Implement `manifestService` (loads manifest + hotspots).
- Build `ReaderProvider` and `PageViewport` skeleton using LD images only.
- Add `HotspotOverlay` using existing article coordinates (no tiles yet). Validate article mode events.

### Phase 2 – Tile Engine
- Deliver tile generator pipeline + storage layout.
- Implement `TileCacheProvider` and `useTileLoader` hooking into the new manifest data.
- Enable crossfade swap between LD base and hi-res tiles; add prefetch for adjacent spreads.

### Phase 3 – Navigation & UX Enhancements
- Add top/bottom bars, progress bar, keyboard + gesture handlers.
- Integrate Flatplan drawer (thumbnail manifest) & summary overlay (article list).
- Introduce animation polish (Framer Motion for overlays, transform transitions).

### Phase 4 – Advanced Features
- Text-to-speech + audio overlays (optional).
- Share / search modals (backed by Supabase or external service).
- Offline caching / PWA support (pre-cache manifest + LD pages).

---

## 8. Dependencies & Tooling

- **Node/Edge tools**: `sharp` for image processing, `pdf-poppler` or `Ghostscript` CLI (packaged for Supabase Edge). For heavy conversion, consider a dedicated worker (Netlify, AWS Lambda).
- **Front-end**: Continue with React 18, add `zustand` or keep custom reducer. For gestures, use `@use-gesture/react` or `hammerjs` fork. For animations, `framer-motion`.
- **Testing**: Integrate Playwright for page/hotspot alignment regression. Unit tests for tile loader (mock `fetch` / `AbortController`).

---

## 9. Open Questions

1. **Tile generation hosting**: Should we offload heavy PDF → image processing to an external job runner to avoid Supabase limits? (Recommended: yes, optional self-hosted worker launched via supabase function.)
2. **Accessibility**: Do we require text layer overlay to support selection in page mode, or is article mode sufficient? (Milibris uses hidden text. Consider building optional overlay once base architecture stable.)
3. **DRM**: For highly sensitive PDFs, consider watermarking each tile server-side (per request). Current spec uses client watermark; evaluate security trade-offs.
4. **Search**: Should we reuse current Supabase search or create dedicated index (e.g., Algolia) for full-text inside articles? (Future phase.)

---

## 10. Next Steps
1. Implement `manifestService` + basic `ReaderProvider` (fetch manifest, handle edition). 
2. Scaffold frontend directories (`contexts`, `hooks`, `services`, `components`). 
3. Draft Supabase migration for `page_assets` & job tracking tables. 
4. Prototype tile generator script locally to validate output before wiring to edge function. 
5. Incrementally replace current `ModernPDFReader` with new architecture (feature flag to switch between engines until parity achieved).

---

This plan positions the reader to match and surpass Milibris, while leveraging current Supabase backend, payment/token flows, and article metadata. As asset pipeline and modular UI mature, we can iterate rapidly on UX features without destabilizing core rendering.


## 11. PDF Conversion Service

- Nouveau service Express (`conversion-service/`) chargé de transformer automatiquement chaque PDF en déclinaisons WebP (low/medium/high + vignette).
- L’Edge Function `convert-pdf-to-images` appelle ce service, met à jour Supabase Storage et alimente la table `pages`.
- La variable `PDF_CONVERSION_SERVICE_SECRET` permet de sécuriser l’appel (entête `X-Api-Key`).
- Le service nécessite Poppler installé sur la machine (utilise `pdf-poppler` + `sharp`).
- Sortie : manifest JSON (`{editionId}/manifest.json`) + chemins vers les assets, utilisés ensuite par `reader-manifest`.

