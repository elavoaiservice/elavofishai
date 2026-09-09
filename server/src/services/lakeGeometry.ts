/**
 * Lake orientation — which way the water runs, so wind advice can talk about
 * fetch honestly instead of assuming every lake is shaped like Granbury.
 *
 * `axisDeg` is the compass bearing of a lake's long axis, 0-179 (an axis has no
 * direction, so 315 and 135 are the same line — both are stored as 135).
 * Sources, best first:
 *   1. the lake profile (hand-verified, or generated with the rest of the AI
 *      profile) — the only source that can see a diagonal lake;
 *   2. the OSM bounding box, which can only distinguish N-S from E-W and only
 *      when the lake is clearly longer one way;
 *   3. nothing — and then the app says nothing about fetch.
 */

/** Normalize any bearing onto the 0-179 axis line. */
export function normalizeAxis(deg: number): number | null {
  if (!Number.isFinite(deg)) return null;
  const d = ((deg % 180) + 180) % 180;
  return Math.round(d);
}

/**
 * Derive an axis from a Nominatim bounding box (JSON "[south,north,west,east]").
 * Returns null for a lake that isn't clearly elongated — a roundish lake has no
 * meaningful axis, and guessing one produces confident nonsense.
 */
export function axisFromBbox(bbox: string | null | undefined): number | null {
  if (!bbox) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(bbox);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length < 4) return null;
  const [s, n, w, e] = parts.map((p) => Number(p));
  if (![s, n, w, e].every((v) => Number.isFinite(v))) return null;

  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const heightKm = Math.abs(n - s) * 111;
  const widthKm = Math.abs(e - w) * 111 * Math.cos(midLat);
  if (heightKm <= 0 || widthKm <= 0) return null;

  const ratio = widthKm > heightKm ? widthKm / heightKm : heightKm / widthKm;
  if (ratio < 1.3) return null; // roundish — no honest axis to report
  return widthKm > heightKm ? 90 : 0; // east-west : north-south
}

/** Human name for an axis bearing, e.g. 135 → "northwest-southeast". */
export function axisLabel(deg: number | null): string | null {
  const d = deg === null ? null : normalizeAxis(deg);
  if (d === null) return null;
  if (d < 22.5 || d >= 157.5) return 'north-south';
  if (d < 67.5) return 'northeast-southwest';
  if (d < 112.5) return 'east-west';
  return 'northwest-southeast';
}

/** Profile first, bounding box second, nothing third. */
export function resolveLakeAxis(
  bbox: string | null | undefined,
  profileContent: unknown
): number | null {
  const fromProfile = (profileContent as { axisDeg?: unknown } | null)?.axisDeg;
  if (typeof fromProfile === 'number') {
    const a = normalizeAxis(fromProfile);
    if (a !== null) return a;
  }
  return axisFromBbox(bbox);
}
