export interface MeasurementReading {
  value: number;
  lighthouseVersion?: string | null;
  measuredAt: number;
}

export interface MeasurementHeadline {
  value?: number;
  lighthouseVersion: string | null;
  includedPages: number;
  excludedPages: number;
  missingPages: number;
  reason:
    | 'missing-readings'
    | 'ambiguous-latest-version'
    | 'unknown-version'
    | 'selected-latest-version'
    | 'single-version';
}

export function measurementHeadline(
  readings: MeasurementReading[],
  pageCount = readings.length
): MeasurementHeadline {
  const newest = Math.max(...readings.map((reading) => reading.measuredAt));
  const newestVersions = new Set(
    readings
      .filter((reading) => reading.measuredAt === newest)
      .map((reading) => reading.lighthouseVersion ?? null)
  );
  const lighthouseVersion = newestVersions.size === 1 ? [...newestVersions][0] : null;
  const included = lighthouseVersion
    ? readings.filter((reading) => reading.lighthouseVersion === lighthouseVersion)
    : [];
  return {
    value: included.length ? Math.max(...included.map((reading) => reading.value)) : undefined,
    lighthouseVersion,
    includedPages: included.length,
    excludedPages: pageCount - included.length,
    missingPages: pageCount - readings.length,
    reason:
      readings.length === 0
        ? 'missing-readings'
        : newestVersions.size > 1
          ? 'ambiguous-latest-version'
          : !lighthouseVersion
            ? 'unknown-version'
            : included.length < readings.length
              ? 'selected-latest-version'
              : 'single-version',
  };
}
