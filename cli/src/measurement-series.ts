export interface MeasurementCompatibility {
  comparable: boolean;
  reason:
    | 'same-version'
    | 'missing-runs'
    | 'unknown-version'
    | 'mixed-versions'
    | 'different-versions';
  baselineVersions: Array<string | null>;
  candidateVersions: Array<string | null>;
  message: string;
}

export interface MeasurementReading {
  value: number;
  lighthouseVersion?: string | null;
  measuredAt: number;
}

export function measurementHeadline(readings: MeasurementReading[], pageCount = readings.length) {
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

export function measurementCompatibility(
  baseline: ReadonlyArray<string | null | undefined>,
  candidate: ReadonlyArray<string | null | undefined>
): MeasurementCompatibility {
  const versions = (values: ReadonlyArray<string | null | undefined>) =>
    [...new Set(values.map((value) => value?.trim() || null))].sort();
  const baselineVersions = versions(baseline);
  const candidateVersions = versions(candidate);
  let reason: MeasurementCompatibility['reason'] = 'same-version';
  let message = 'Same Lighthouse version';
  if (baseline.length === 0 || candidate.length === 0) {
    reason = 'missing-runs';
    message =
      baseline.length === 0
        ? 'No successful baseline series; collect one under a new tag and update the watchlist baseline tag'
        : 'No successful candidate series; collect it under a new tag before comparing';
  } else if (baselineVersions.length !== 1 || candidateVersions.length !== 1) {
    reason = 'mixed-versions';
    message =
      'A run series mixes Lighthouse versions; collect under new tags and update the watchlist baseline tag';
  } else if (baselineVersions.includes(null) || candidateVersions.includes(null)) {
    reason = 'unknown-version';
    message =
      'Lighthouse version is unknown; collect under new tags and update the watchlist baseline tag';
  } else if (baselineVersions[0] !== candidateVersions[0]) {
    reason = 'different-versions';
    message = 'Lighthouse versions differ; engine changes are not product performance changes';
  }
  return {
    comparable: reason === 'same-version',
    reason,
    baselineVersions,
    candidateVersions,
    message,
  };
}
