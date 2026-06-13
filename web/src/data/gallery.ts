export interface GalleryMetricSnapshot {
  tag: string;
  preset: string;
  lcpP75Ms: number;
  perfScoreP75: number;
  clsP75: number;
  tbtP75Ms: number;
}

export interface GalleryEntry {
  id: string;
  title: string;
  url: string;
  summary: string;
  narrative: string;
  before: GalleryMetricSnapshot;
  after: GalleryMetricSnapshot;
  /** Static fixture label — not live data. */
  fixture: true;
}

/** Curated static fixtures for demos, README screenshots, and CI review. */
export const GALLERY_ENTRIES: GalleryEntry[] = [
  {
    id: 'astro-overlay',
    title: 'Marketing landing → Astro overlay',
    url: 'https://example.com/',
    summary: 'Moved a static marketing hero off a dynamic Worker shell onto prerendered Astro HTML.',
    narrative:
      'The baseline Worker route paid SSR + hydration cost before the hero rendered. The overlay pattern prerendered the LCP block and inlined critical CSS, cutting mobile LCP p75 by ~1.1s without changing the product URL.',
    before: {
      tag: 'before-overlay',
      preset: 'mobile-mid',
      lcpP75Ms: 1680,
      perfScoreP75: 71,
      clsP75: 0.04,
      tbtP75Ms: 420,
    },
    after: {
      tag: 'after-overlay',
      preset: 'mobile-mid',
      lcpP75Ms: 540,
      perfScoreP75: 96,
      clsP75: 0.02,
      tbtP75Ms: 90,
    },
    fixture: true,
  },
  {
    id: 'self-hosted-fonts',
    title: 'Self-hosted fonts + preload',
    url: 'https://docs.example.com/',
    summary: 'Removed a third-party font chain and preloaded the local WOFF2 used by the hero.',
    narrative:
      'Google Fonts added two round trips and pushed render-blocking CSS. Self-hosting with `font-display: swap` and a single preload dropped TBT and stabilized LCP variance across runs.',
    before: {
      tag: 'before-fonts',
      preset: 'desktop',
      lcpP75Ms: 1320,
      perfScoreP75: 78,
      clsP75: 0.01,
      tbtP75Ms: 310,
    },
    after: {
      tag: 'after-fonts',
      preset: 'desktop',
      lcpP75Ms: 780,
      perfScoreP75: 94,
      clsP75: 0.01,
      tbtP75Ms: 120,
    },
    fixture: true,
  },
  {
    id: 'cache-rules',
    title: 'Edge cache rules for static shell',
    url: 'https://app.example.com/dashboard',
    summary: 'Added Cache Rules for the HTML shell while keeping authenticated API routes dynamic.',
    narrative:
      'Cold TTFB dominated p75 on a custom domain. Cache Rules on the static shell plus `caches.default` wrapping for GET `/` reduced repeat-view TTFB without touching authenticated mutations.',
    before: {
      tag: 'before-cache',
      preset: 'mobile-mid',
      lcpP75Ms: 2890,
      perfScoreP75: 62,
      clsP75: 0.06,
      tbtP75Ms: 510,
    },
    after: {
      tag: 'after-cache',
      preset: 'mobile-mid',
      lcpP75Ms: 1180,
      perfScoreP75: 88,
      clsP75: 0.05,
      tbtP75Ms: 260,
    },
    fixture: true,
  },
];

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function deltaLabel(before: number, after: number, lowerIsBetter = true): string {
  const delta = after - before;
  const pct = before === 0 ? 0 : (delta / before) * 100;
  const sign = delta > 0 ? '+' : '';
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return `${sign}${Math.round(delta)} (${sign}${pct.toFixed(0)}%)${improved ? ' ✓' : ''}`;
}
