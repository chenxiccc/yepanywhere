/** Server-owned visual identity shown for the current YA host. */
export interface HostIdentity {
  icon: string;
}

/** Keep persisted custom markers small while allowing joined emoji sequences. */
export const MAX_HOST_IDENTITY_ICON_CODE_UNITS = 32;

/**
 * Normalize one user-perceived marker character. Emoji sequences such as
 * family glyphs, flags, keycaps, and variation selectors count as one marker.
 */
export function normalizeHostIdentityIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (icon.length === 0 || icon.length > MAX_HOST_IDENTITY_ICON_CODE_UNITS) {
    return null;
  }

  if (typeof Intl.Segmenter !== "function") {
    return Array.from(icon).length === 1 ? icon : null;
  }

  const segments = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(icon);
  const iterator = segments[Symbol.iterator]();
  const first = iterator.next();
  if (first.done || !iterator.next().done) return null;
  return icon;
}
