export const BUILD_DATE_PATH = 'build-date.json';

export function parseBuildDate(value: unknown, sourceSha: string | null): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const date = record.date;
  if (
    Object.keys(record).length !== 2 ||
    record.sourceSha !== sourceSha ||
    (sourceSha !== null && !/^[a-f0-9]{40}$/.test(sourceSha)) ||
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  )
    return null;
  const instant = new Date(date);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date
    ? date
    : null;
}
