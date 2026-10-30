export interface LighthouseProvenance {
  schemaVersion: 1;
  lighthouseVersion?: string;
  browserUserAgent?: string;
  nodeVersion?: string;
  chromeFlags?: string[];
  benchmarkIndex?: number;
  throttlingMethod?: string;
  formFactor?: string;
  screenEmulation: Record<string, number | boolean>;
  throttling: Record<string, number>;
  runWarnings?: string[];
  runtimeErrorCode?: string | null;
  observed: { fcpMs?: number; lcpMs?: number; siMs?: number };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numbers(source: Record<string, unknown>, keys: string[]): Record<string, number> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = numeric(source[key]);
      return value === undefined ? [] : [[key, value]];
    })
  );
}

/** Only retain measurement provenance, never the full config, headers or trace. */
export function captureLighthouseProvenance(value: unknown): LighthouseProvenance {
  const lhr = record(value);
  const settings = record(lhr.configSettings);
  const environment = record(lhr.environment);
  const screen = record(settings.screenEmulation);
  const details = record(record(record(lhr.audits).metrics).details);
  const observed = record(Array.isArray(details.items) ? details.items[0] : undefined);
  const screenEmulation: LighthouseProvenance['screenEmulation'] = numbers(screen, [
    'width',
    'height',
    'deviceScaleFactor',
  ]);
  for (const key of ['mobile', 'disabled']) {
    if (typeof screen[key] === 'boolean') screenEmulation[key] = screen[key];
  }
  return {
    schemaVersion: 1,
    lighthouseVersion: text(lhr.lighthouseVersion),
    browserUserAgent: text(environment.hostUserAgent) ?? text(lhr.userAgent),
    benchmarkIndex: numeric(environment.benchmarkIndex),
    throttlingMethod: ['simulate', 'devtools', 'provided'].includes(
      String(settings.throttlingMethod)
    )
      ? text(settings.throttlingMethod)
      : undefined,
    formFactor: ['mobile', 'desktop'].includes(String(settings.formFactor))
      ? text(settings.formFactor)
      : undefined,
    screenEmulation,
    throttling: numbers(record(settings.throttling), [
      'rttMs',
      'throughputKbps',
      'requestLatencyMs',
      'downloadThroughputKbps',
      'uploadThroughputKbps',
      'cpuSlowdownMultiplier',
    ]),
    runWarnings:
      Array.isArray(lhr.runWarnings) &&
      lhr.runWarnings.every((warning) => typeof warning === 'string')
        ? [...lhr.runWarnings]
        : undefined,
    runtimeErrorCode: lhr.runtimeError == null ? null : text(record(lhr.runtimeError).code),
    observed: {
      fcpMs: numeric(observed.observedFirstContentfulPaint),
      lcpMs: numeric(observed.observedLargestContentfulPaint),
      siMs: numeric(observed.observedSpeedIndex),
    },
  };
}
