import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = join(homedir(), '.psi-swarm');
const DEFAULT_DB = join(DEFAULT_DIR, 'history.db');

export interface RunRow {
  id: number;
  url: string;
  preset: string;
  started_at: number;
  finished_at: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  tbt: number | null;
  fcp: number | null;
  ttfb: number | null;
  si: number | null;
  performance_score: number | null;
  error: string | null;
  tag: string | null;
}

export interface NewRun {
  url: string;
  preset: string;
  started_at: number;
  finished_at: number;
  metrics?: {
    lcp?: number;
    cls?: number;
    inp?: number;
    tbt?: number;
    fcp?: number;
    ttfb?: number;
    si?: number;
    performance_score?: number;
  };
  error?: string;
  tag?: string;
}

export interface RunInsightRow {
  run_id: number;
  bottleneck_phase: string | null;
  summary: string;
  opportunities_json: string;
  comparison_notes: string | null;
  adapter: string;
  artifact_path: string | null;
  created_at: number;
}

export interface WatchlistEntry {
  url: string;
  label: string | null;
  preset: string;
  baseline_tag: string | null;
  lcp_threshold_ms: number | null;
  score_threshold: number | null;
  stale_days: number;
  added_at: number;
}

export class HistoryDB {
  private db: Database.Database;

  constructor(path: string = DEFAULT_DB) {
    mkdirSync(DEFAULT_DIR, { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        preset TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        lcp REAL,
        cls REAL,
        inp REAL,
        tbt REAL,
        fcp REAL,
        ttfb REAL,
        si REAL,
        performance_score REAL,
        error TEXT,
        tag TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_url_preset ON runs(url, preset);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_tag ON runs(tag);

      CREATE TABLE IF NOT EXISTS domain_ratings (
        domain TEXT PRIMARY KEY,
        rating REAL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_domain_ratings_fetched_at ON domain_ratings(fetched_at);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_insights (
        run_id INTEGER PRIMARY KEY,
        bottleneck_phase TEXT,
        summary TEXT NOT NULL,
        opportunities_json TEXT NOT NULL DEFAULT '[]',
        comparison_notes TEXT,
        adapter TEXT NOT NULL,
        artifact_path TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS watchlist (
        url TEXT PRIMARY KEY,
        label TEXT,
        preset TEXT NOT NULL DEFAULT 'mobile-mid',
        baseline_tag TEXT,
        lcp_threshold_ms REAL,
        score_threshold REAL,
        stale_days INTEGER NOT NULL DEFAULT 7,
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_watchlist_added_at ON watchlist(added_at);
    `);
    this.migrateDomainRatingsNullable();
  }

  /**
   * Older DBs created domain_ratings with `rating REAL NOT NULL`. Rating must be
   * nullable so a NULL row can negative-cache "Ahrefs has no rating for this domain".
   */
  private migrateDomainRatingsNullable() {
    const cols = this.db.pragma('table_info(domain_ratings)') as Array<{ name: string; notnull: number }>;
    const ratingCol = cols.find((c) => c.name === 'rating');
    if (!ratingCol || ratingCol.notnull === 0) return;
    this.db.exec(`
      BEGIN;
      ALTER TABLE domain_ratings RENAME TO domain_ratings_old;
      CREATE TABLE domain_ratings (
        domain TEXT PRIMARY KEY,
        rating REAL,
        fetched_at INTEGER NOT NULL
      );
      INSERT INTO domain_ratings (domain, rating, fetched_at)
        SELECT domain, rating, fetched_at FROM domain_ratings_old;
      DROP TABLE domain_ratings_old;
      CREATE INDEX IF NOT EXISTS idx_domain_ratings_fetched_at ON domain_ratings(fetched_at);
      COMMIT;
    `);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  /** rating === null is a negative-cache sentinel: Ahrefs reported no rating. */
  getDomainRating(domain: string): { domain: string; rating: number | null; fetchedAt: number } | null {
    const row = this.db
      .prepare(`SELECT domain, rating, fetched_at as fetchedAt FROM domain_ratings WHERE domain = ?`)
      .get(domain.toLowerCase()) as { domain: string; rating: number | null; fetchedAt: number } | undefined;
    return row ?? null;
  }

  domainRatings(): Map<string, { domain: string; rating: number | null; fetchedAt: number }> {
    const rows = this.db
      .prepare(`SELECT domain, rating, fetched_at as fetchedAt FROM domain_ratings`)
      .all() as Array<{ domain: string; rating: number | null; fetchedAt: number }>;
    const out = new Map<string, { domain: string; rating: number | null; fetchedAt: number }>();
    for (const row of rows) out.set(row.domain.toLowerCase(), row);
    return out;
  }

  upsertDomainRating(entry: { domain: string; rating: number | null; fetchedAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO domain_ratings (domain, rating, fetched_at)
         VALUES (@domain, @rating, @fetchedAt)
         ON CONFLICT(domain) DO UPDATE SET
           rating = excluded.rating,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        domain: entry.domain.toLowerCase(),
        rating: entry.rating,
        fetchedAt: entry.fetchedAt,
      });
  }

  /** Distinct URL origins seen in run history. */
  trackedOrigins(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT url FROM runs`).all() as Array<{ url: string }>;
    const origins = new Set<string>();
    for (const { url } of rows) {
      try {
        origins.add(new URL(url).origin);
      } catch {
        /* skip malformed */
      }
    }
    return [...origins];
  }

  insert(r: NewRun): number {
    const stmt = this.db.prepare(`
      INSERT INTO runs (
        url, preset, started_at, finished_at,
        lcp, cls, inp, tbt, fcp, ttfb, si, performance_score,
        error, tag
      ) VALUES (
        @url, @preset, @started_at, @finished_at,
        @lcp, @cls, @inp, @tbt, @fcp, @ttfb, @si, @performance_score,
        @error, @tag
      )
    `);
    const m = r.metrics ?? {};
    const result = stmt.run({
      url: r.url,
      preset: r.preset,
      started_at: r.started_at,
      finished_at: r.finished_at,
      lcp: m.lcp ?? null,
      cls: m.cls ?? null,
      inp: m.inp ?? null,
      tbt: m.tbt ?? null,
      fcp: m.fcp ?? null,
      ttfb: m.ttfb ?? null,
      si: m.si ?? null,
      performance_score: m.performance_score ?? null,
      error: r.error ?? null,
      tag: r.tag ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  recentRuns(url: string, preset?: string, limit = 500): RunRow[] {
    if (preset) {
      return this.db
        .prepare(
          `SELECT * FROM runs WHERE url = ? AND preset = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(url, preset, limit) as RunRow[];
    }
    return this.db
      .prepare(`SELECT * FROM runs WHERE url = ? ORDER BY started_at DESC LIMIT ?`)
      .all(url, limit) as RunRow[];
  }

  runsByTag(url: string, tag: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE url = ? AND tag = ? ORDER BY started_at DESC`,
      )
      .all(url, tag) as RunRow[];
  }

  urls(): { url: string; count: number; last: number }[] {
    return this.db
      .prepare(
        `SELECT url, COUNT(*) as count, MAX(started_at) as last
         FROM runs GROUP BY url ORDER BY last DESC`,
      )
      .all() as { url: string; count: number; last: number }[];
  }

  /**
   * For each tracked URL, return aggregate stats useful for a fleet dashboard:
   * total runs, last run time, plus median LCP/CLS/perf-score over the last `windowDays`
   * for both mobile-mid and desktop presets.
   */
  projects(windowDays = 30): Array<{
    url: string;
    totalRuns: number;
    lastRunAt: number;
    mobileLcpP75?: number;
    desktopLcpP75?: number;
    mobilePerfScoreP50?: number;
    desktopPerfScoreP50?: number;
    cls?: number;
  }> {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const urls = this.db
      .prepare(`SELECT url, COUNT(*) as count, MAX(started_at) as last FROM runs GROUP BY url ORDER BY last DESC`)
      .all() as { url: string; count: number; last: number }[];

    const stmt = this.db.prepare(
      `SELECT lcp, cls, performance_score FROM runs
       WHERE url = ? AND preset = ? AND started_at >= ? AND error IS NULL
       ORDER BY started_at DESC LIMIT 200`,
    );

    const percentile = (vs: number[], p: number): number | undefined => {
      const xs = vs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
      if (xs.length === 0) return undefined;
      const idx = (p / 100) * (xs.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return xs[lo];
      const w = idx - lo;
      return xs[lo] * (1 - w) + xs[hi] * w;
    };

    return urls.map((u) => {
      const mobile = stmt.all(u.url, 'mobile-mid', cutoff) as Array<{ lcp: number | null; cls: number | null; performance_score: number | null }>;
      const desktop = stmt.all(u.url, 'desktop', cutoff) as Array<{ lcp: number | null; cls: number | null; performance_score: number | null }>;
      const mlcp = mobile.map((r) => r.lcp).filter((v): v is number => typeof v === 'number');
      const dlcp = desktop.map((r) => r.lcp).filter((v): v is number => typeof v === 'number');
      const mscore = mobile.map((r) => r.performance_score).filter((v): v is number => typeof v === 'number');
      const dscore = desktop.map((r) => r.performance_score).filter((v): v is number => typeof v === 'number');
      const allCls = [...mobile, ...desktop].map((r) => r.cls).filter((v): v is number => typeof v === 'number');
      return {
        url: u.url,
        totalRuns: u.count,
        lastRunAt: u.last,
        mobileLcpP75: percentile(mlcp, 75),
        desktopLcpP75: percentile(dlcp, 75),
        mobilePerfScoreP50: percentile(mscore, 50),
        desktopPerfScoreP50: percentile(dscore, 50),
        cls: percentile(allCls, 75),
      };
    });
  }

  /**
   * Per-URL time series for sparklines. Returns up to `limit` recent runs across
   * any preset, grouped by run (preserves preset for client filtering).
   */
  recentRunIds(url: string, preset: string, limit = 1): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM runs WHERE url = ? AND preset = ? AND error IS NULL ORDER BY started_at DESC LIMIT ?`,
      )
      .all(url, preset, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  upsertRunInsight(input: {
    runId: number;
    bottleneckPhase?: string;
    summary: string;
    opportunities?: string[];
    comparisonNotes?: string;
    adapter: string;
    artifactPath?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_insights (
          run_id, bottleneck_phase, summary, opportunities_json, comparison_notes, adapter, artifact_path, created_at
        ) VALUES (
          @runId, @bottleneckPhase, @summary, @opportunitiesJson, @comparisonNotes, @adapter, @artifactPath, @createdAt
        )
        ON CONFLICT(run_id) DO UPDATE SET
          bottleneck_phase = excluded.bottleneck_phase,
          summary = excluded.summary,
          opportunities_json = excluded.opportunities_json,
          comparison_notes = excluded.comparison_notes,
          adapter = excluded.adapter,
          artifact_path = excluded.artifact_path,
          created_at = excluded.created_at`,
      )
      .run({
        runId: input.runId,
        bottleneckPhase: input.bottleneckPhase ?? null,
        summary: input.summary,
        opportunitiesJson: JSON.stringify(input.opportunities ?? []),
        comparisonNotes: input.comparisonNotes ?? null,
        adapter: input.adapter,
        artifactPath: input.artifactPath ?? null,
        createdAt: Date.now(),
      });
  }

  runInsightsForUrl(url: string, limit = 20): Array<RunInsightRow & { preset: string; started_at: number }> {
    return this.db
      .prepare(
        `SELECT ri.*, r.preset, r.started_at
         FROM run_insights ri
         JOIN runs r ON r.id = ri.run_id
         WHERE r.url = ?
         ORDER BY r.started_at DESC
         LIMIT ?`,
      )
      .all(url, limit) as Array<RunInsightRow & { preset: string; started_at: number }>;
  }

  addWatchlist(entry: {
    url: string;
    label?: string;
    preset?: string;
    baselineTag?: string;
    lcpThresholdMs?: number;
    scoreThreshold?: number;
    staleDays?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO watchlist (
          url, label, preset, baseline_tag, lcp_threshold_ms, score_threshold, stale_days, added_at
        ) VALUES (
          @url, @label, @preset, @baselineTag, @lcpThresholdMs, @scoreThreshold, @staleDays, @addedAt
        )
        ON CONFLICT(url) DO UPDATE SET
          label = excluded.label,
          preset = excluded.preset,
          baseline_tag = excluded.baseline_tag,
          lcp_threshold_ms = excluded.lcp_threshold_ms,
          score_threshold = excluded.score_threshold,
          stale_days = excluded.stale_days`,
      )
      .run({
        url: entry.url,
        label: entry.label ?? null,
        preset: entry.preset ?? 'mobile-mid',
        baselineTag: entry.baselineTag ?? null,
        lcpThresholdMs: entry.lcpThresholdMs ?? null,
        scoreThreshold: entry.scoreThreshold ?? null,
        staleDays: entry.staleDays ?? 7,
        addedAt: Date.now(),
      });
  }

  removeWatchlist(url: string): boolean {
    const result = this.db.prepare(`DELETE FROM watchlist WHERE url = ?`).run(url);
    return result.changes > 0;
  }

  listWatchlist(): WatchlistEntry[] {
    return this.db
      .prepare(`SELECT * FROM watchlist ORDER BY added_at DESC`)
      .all() as WatchlistEntry[];
  }

  history(url: string, limit = 60): Array<{
    started_at: number;
    preset: string;
    lcp: number | null;
    cls: number | null;
    tbt: number | null;
    fcp: number | null;
    ttfb: number | null;
    performance_score: number | null;
    tag: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT started_at, preset, lcp, cls, tbt, fcp, ttfb, performance_score, tag
         FROM runs WHERE url = ? AND error IS NULL ORDER BY started_at DESC LIMIT ?`,
      )
      .all(url, limit) as Array<{
        started_at: number; preset: string;
        lcp: number | null; cls: number | null; tbt: number | null;
        fcp: number | null; ttfb: number | null; performance_score: number | null;
        tag: string | null;
      }>;
  }

  close() {
    this.db.close();
  }
}
