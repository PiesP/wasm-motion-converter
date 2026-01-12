/**
 * Codec Utils
 *
 * Pure helpers for normalizing and classifying codec strings.
 */

export function normalizeCodecString(codec: string | undefined): string {
  return (codec ?? "").trim().toLowerCase();
}

export function isAv1Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return c === "av1" || c.startsWith("av01") || c.includes("av1");
}

export function isH264Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return (
    c === "h264" ||
    c === "h.264" ||
    c === "h-264" ||
    c.includes("avc") ||
    c.startsWith("avc1") ||
    c.startsWith("avc3")
  );
}

export function isHevcCodec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return (
    c === "hevc" ||
    c === "h265" ||
    c === "h.265" ||
    c === "h-265" ||
    c.startsWith("hvc1") ||
    c.startsWith("hev1")
  );
}
