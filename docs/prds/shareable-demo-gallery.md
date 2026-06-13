# Shareable Demo Gallery

**Status:** Shipped · **Release:** v0.4.0 · **Updated:** 2026-06-13

## What it is

A deterministic demo gallery so new users can see before/after comparison output without running the CLI or exposing local history. All entries are static fixtures, clearly labeled.

## Entry points

| Surface | Path |
|---------|------|
| Web UI | `/gallery` (no local agent required) |
| Fixtures | `web/src/data/gallery.ts` |
| Docs | README → Demo gallery section |

## Behavior

- Three curated stories: Astro overlay, self-hosted fonts, edge cache rules.
- Each card shows URL label, narrative, and before/after p75 table (LCP, perf score, CLS, TBT).
- Fixtures are synthetic — not live site data.
- Nav links from `/`, `/projects`, and `/watchlist`.

## Implementation

- `web/src/data/gallery.ts` — fixture format + entries
- `web/src/components/GalleryView.tsx` — renderer
- `web/src/pages/gallery.astro` — page shell

## Follow-up

Expand the fixture set only when report shapes and the gallery UI are stable.
