import { HistoryDB } from './db.js';
import { fetchDomainRatings, DOMAIN_RATING_TTL_MS } from './ahrefs.js';
import { hostnameFromUrl, shouldFetchDomainRating } from './domain.js';

const DOMAIN_RATING_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly idle probe
const DOMAIN_RATING_STARTUP_DELAY_MS = 30_000;

const META_LAST_REFRESH = 'ahrefs_last_refresh_at';

export interface DomainRatingSchedulerDeps {
  isIdle: () => boolean;
  openHistory?: () => HistoryDB;
  onRefresh?: (info: { domains: number; refreshedAt: number }) => void;
  onError?: (err: Error) => void;
}

export function createDomainRatingScheduler(deps: DomainRatingSchedulerDeps): {
  start: () => void;
  stop: () => void;
  refreshNow: () => Promise<boolean>;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInProgress = false;

  async function refreshNow(): Promise<boolean> {
    if (refreshInProgress || !deps.isIdle()) return false;

    const db = deps.openHistory?.() ?? new HistoryDB();
    try {
      const origins = db.trackedOrigins();
      const eligible = [
        ...new Set(
          origins
            .map((o) => hostnameFromUrl(o))
            .filter((d): d is string => !!d && shouldFetchDomainRating(`https://${d}/`))
        ),
      ];
      if (eligible.length === 0) return false;

      refreshInProgress = true;
      const { ratings, resolved } = await fetchDomainRatings(
        eligible.map((d) => `https://${d}/`),
        { concurrency: 3, force: true, db }
      );
      const refreshedAt = Date.now();
      // Only stamp when at least one lookup landed (rating or no-rating sentinel);
      // otherwise a fully-failed pass would suppress retries for a whole TTL.
      if (resolved > 0) {
        db.setMeta(META_LAST_REFRESH, String(refreshedAt));
      }
      deps.onRefresh?.({ domains: ratings.size, refreshedAt });
      return true;
    } catch (err) {
      deps.onError?.(err as Error);
      return false;
    } finally {
      refreshInProgress = false;
      db.close();
    }
  }

  async function maybeRefresh(): Promise<void> {
    if (refreshInProgress || !deps.isIdle()) return;

    const db = deps.openHistory?.() ?? new HistoryDB();
    let due = false;
    try {
      const lastRefresh = Number(db.getMeta(META_LAST_REFRESH) ?? '0');
      if (!lastRefresh || Date.now() - lastRefresh >= DOMAIN_RATING_TTL_MS) {
        due = true;
      } else {
        const origins = db.trackedOrigins();
        const eligible = origins
          .map((o) => hostnameFromUrl(o))
          .filter((d): d is string => !!d && shouldFetchDomainRating(`https://${d}/`));
        // stored includes no-rating sentinel rows (rating null) — a fresh sentinel
        // counts as "checked", so unrated domains aren't refetched every probe.
        const stored = db.domainRatings();
        due = eligible.some((domain) => {
          const hit = stored.get(domain.toLowerCase());
          return !hit || Date.now() - hit.fetchedAt >= DOMAIN_RATING_TTL_MS;
        });
      }
    } finally {
      db.close();
    }

    if (due) await refreshNow();
  }

  return {
    start() {
      if (timer) return;
      startupTimer = setTimeout(() => {
        void maybeRefresh();
      }, DOMAIN_RATING_STARTUP_DELAY_MS);
      timer = setInterval(() => {
        void maybeRefresh();
      }, DOMAIN_RATING_CHECK_INTERVAL_MS);
    },
    stop() {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    refreshNow,
  };
}
