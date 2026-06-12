# PRD: Shareable Demo Gallery

Last updated: 2026-06-12

## Summary

psi-swarm is strongest when it compares real sites before and after a change.
This PRD adds a small gallery of curated demo reports so the product can show
what good output looks like without forcing users to run a swarm first.

## Problem

The current docs explain the product, but they do not show a durable set of
realistic performance stories. That makes the web UI harder to evaluate and the
project harder to demo in a consistent way.

## Goal

Create a lightweight public-facing gallery of sample reports that highlights
psi-swarm's comparison workflow and makes the product easier to understand.

## Non-Goals

- Do not add RUM.
- Do not turn the gallery into a general CMS.
- Do not require user accounts.
- Do not expose local history data by default.

## Users

- New users evaluating whether psi-swarm fits their workflow.
- Maintainers preparing release notes or demos.
- Engineers comparing the product with other performance tools.

## Proposed Behavior

1. The web surface includes a gallery page with a few curated examples.
2. Each example shows:
   - URL or site label
   - before/after percentile comparison
   - a short explanation of the performance change
   - links to the underlying report artifact
3. The gallery is populated from static fixtures so it stays deterministic.
4. The same gallery can be reused for screenshots, README examples, and release
   notes.

## Success Criteria

- New visitors can understand the product without running the CLI.
- The gallery gives the web UI a stable demo path that does not depend on live
  sites.
- The examples stay reproducible across machines and CI runs.

## Risks

- Curated samples can go stale if they do not track the current UI.
- If the gallery grows too large, it may become a maintenance burden.
- Static examples can overpromise if they are not clearly labeled as fixtures.

## Implementation Slice

1. Define a small fixture format for gallery entries.
2. Build a gallery page in the web app using those fixtures.
3. Add matching README links or screenshots.
4. Keep the examples deterministic and reviewable in CI.

