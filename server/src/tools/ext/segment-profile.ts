/**
 * How speed changes between two keyframes. Lives apart from motion.ts so choreography.ts can use
 * it without importing motion.ts (which imports choreography.ts).
 */
export type SegmentProfile =
  | "hold"
  | "static"
  | "constant"
  | "ease in-out"
  | "speeds up"
  | "slows down"
  | "uneven";

/**
 * Names how speed changes between two keys. "Slow" means under half the
 * segment's peak: an Easy Ease starts and ends near zero, while linear keys
 * keep one speed throughout.
 */
export function segmentProfile(startSpeed: number, endSpeed: number, peak: number, hold: boolean): SegmentProfile {
  if (hold) return "hold";
  if (peak < 1e-6) return "static";
  const s = startSpeed / peak;
  const e = endSpeed / peak;
  if (s > 0.8 && e > 0.8) return "constant";
  if (s < 0.5 && e < 0.5) return "ease in-out";
  if (s < 0.5 && e > 0.8) return "speeds up";
  if (s > 0.8 && e < 0.5) return "slows down";
  return "uneven";
}
