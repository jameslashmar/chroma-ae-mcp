/**
 * The motion spec: a project's motion language as numbers. It is stored in the brief
 * (<name>.brief.json, field `motion`, see tools/ext/brief.ts) and read by the motion,
 * timing and house-style checks for their thresholds. Anything the brief leaves out comes
 * from the register's defaults below.
 *
 * Source of the numbers: the chroma-motion-director skill (chroma-skills repo), which
 * merges eight public motion-design skills; see docs/MOTION-RESEARCH.md.
 */
import { z } from "zod";

export const MOTION_REGISTERS = ["ui_micro", "brand_film", "energetic", "handmade"] as const;
export type MotionRegister = (typeof MOTION_REGISTERS)[number];

/** Named cubic-bezier eases [x1, y1, x2, y2] (CSS convention). */
export const NAMED_EASES = {
  premium: [0.4, 0, 0.2, 1],
  standard: [0.2, 0, 0, 1],
  emphasized: [0.05, 0.7, 0.1, 1],
  expo_out: [0.16, 1, 0.3, 1],
  quart_out: [0.25, 1, 0.5, 1],
  exit: [0.3, 0, 1, 1],
  in_out: [0.65, 0, 0.35, 1],
  camera: [0.37, 0, 0.63, 1],
  apple: [0.25, 0.1, 0.25, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type NamedEase = keyof typeof NAMED_EASES;

const Bezier = z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]);

/** Platform safe-zone presets. Fractions are of the comp's width or height. */
export const PLATFORM_PRESETS = {
  /** Any format: 80 % title-safe box. */
  title_safe: { label: "Title safe (10 % in from each edge)", left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 },
  /** 16:9: captions 80-120 px above the bottom at 1080 high. */
  landscape_16_9: { label: "16:9 landscape", left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 },
  /**
   * 9:16 reels and shorts at 1080x1920: anything that matters between y 168 and y 1330,
   * out of the right 120 px (the action rail).
   */
  reels_9_16: { label: "9:16 reels / shorts / TikTok", left: 0.05, right: 120 / 1080, top: 168 / 1920, bottom: (1920 - 1330) / 1920 },
  /** 9:16 promo layout: CTA above the bottom 15 %, title above the bottom 22 %, top 10 % clear. */
  promo_9_16: { label: "9:16 promo (title above the bottom 22 %)", left: 0.067, right: 0.12, top: 0.1, bottom: 0.22 },
  /** 4:5 feed posts. */
  feed_4_5: { label: "4:5 feed", left: 0.067, right: 0.067, top: 0.067, bottom: 0.067 },
  /** 1:1 square. */
  square_1_1: { label: "1:1 square", left: 0.067, right: 0.067, top: 0.067, bottom: 0.067 },
} as const;
export type PlatformPreset = keyof typeof PLATFORM_PRESETS;
export const PLATFORM_PRESET_IDS = Object.keys(PLATFORM_PRESETS) as PlatformPreset[];

export const MotionBeatSchema = z
  .object({
    start_s: z.number().min(0),
    end_s: z.number().min(0),
    role: z.string().min(1).max(40).optional().describe("hook, tension, reveal, proof, payoff, claim, cta, ..."),
    text: z.string().max(300).optional().describe("What is on screen in this beat."),
    hero_s: z.number().min(0).optional().describe("The frame that must work as a still."),
  })
  .refine((b) => b.end_s > b.start_s, { message: "a beat must end after it starts (end_s > start_s)", path: ["end_s"] })
  .refine((b) => b.hero_s === undefined || (b.hero_s >= b.start_s && b.hero_s <= b.end_s), {
    message: "hero_s must fall inside the beat (start_s..end_s)",
    path: ["hero_s"],
  });

export const MotionSpecSchema = z
  .object({
    register: z.enum(MOTION_REGISTERS).optional().describe("ui_micro, brand_film (default), energetic or handmade."),
    signature_ease: z.union([z.enum(Object.keys(NAMED_EASES) as [NamedEase, ...NamedEase[]]), Bezier]).optional().describe("The ease for about 80 % of moves: a name or [x1, y1, x2, y2]."),
    durations_ms: z
      .object({ short: z.number().positive(), medium: z.number().positive(), long: z.number().positive() })
      .partial()
      .optional()
      .describe("The three-tier duration palette."),
    stagger_ms: z
      .object({ words: z.number().min(0), items: z.number().min(0), group_total_max: z.number().positive() })
      .partial()
      .optional(),
    overshoot_max_pct: z.number().min(0).max(100).optional().describe("Largest overshoot allowed on position or scale. Opacity, colour and numbers never overshoot."),
    exit_ratio: z
      .object({ min: z.number().positive(), max: z.number().positive() })
      .optional()
      .describe("Exit duration as a fraction of the entrance's (default 0.5-0.6, i.e. 40-50 % shorter)."),
    max_same_ease: z.number().int().min(1).optional().describe("Most tweens per comp that may share one ease and duration (default 2)."),
    entrance_pattern: z.string().max(200).optional(),
    transitions: z
      .object({ primary: z.string().max(60).optional(), accents: z.array(z.string().max(60)).max(4).optional() })
      .optional(),
    platform: z.enum(PLATFORM_PRESET_IDS as [PlatformPreset, ...PlatformPreset[]]).optional().describe("Safe-zone preset for text and logos."),
    min_text_pct: z.number().positive().max(50).optional().describe("Smallest text height as a % of the comp's short side (default 2.6)."),
    reading: z
      .object({ base_s: z.number().min(0), per_word_s: z.number().min(0), last_line_s: z.number().min(0) })
      .partial()
      .optional()
      .describe("Reading time: base + per word; the last line at least last_line_s (defaults 0.5, 0.3, 2)."),
    dead_stretch_s: z.number().positive().optional().describe("Longest span with nothing changing (default 3)."),
    facts: z.array(z.string().min(1).max(200)).max(200).optional().describe("Approved names, dates and numbers; other text on screen is flagged."),
    banned: z.array(z.string().min(1).max(200)).max(20).optional(),
    beats: z.array(MotionBeatSchema).max(100).optional(),
  })
  .describe("The motion language as numbers; checks read their thresholds from it.");

export type MotionSpec = z.infer<typeof MotionSpecSchema>;

export interface ResolvedMotionSpec {
  register: MotionRegister;
  signature_ease: readonly [number, number, number, number];
  durations_ms: { short: number; medium: number; long: number };
  stagger_ms: { words: number; items: number; group_total_max: number };
  overshoot_max_pct: number;
  exit_ratio: { min: number; max: number };
  max_same_ease: number;
  platform: PlatformPreset;
  min_text_pct: number;
  reading: { base_s: number; per_word_s: number; last_line_s: number };
  dead_stretch_s: number;
  /** Longest spatial tween (s) before it counts as slow, cameras and ambient aside. */
  long_tween_s: number;
  facts: string[];
  banned: string[];
  beats: z.infer<typeof MotionBeatSchema>[];
  /** Which fields came from the brief rather than the register defaults. */
  from_brief: string[];
}

type RegisterDefaults = Omit<ResolvedMotionSpec, "register" | "facts" | "banned" | "beats" | "from_brief">;

const COMMON = {
  exit_ratio: { min: 0.5, max: 0.6 },
  max_same_ease: 2,
  platform: "title_safe" as PlatformPreset,
  min_text_pct: 2.6,
  reading: { base_s: 0.5, per_word_s: 0.3, last_line_s: 2 },
  dead_stretch_s: 3,
};

export const REGISTER_DEFAULTS: Record<MotionRegister, RegisterDefaults> = {
  ui_micro: {
    ...COMMON,
    signature_ease: NAMED_EASES.standard,
    durations_ms: { short: 150, medium: 250, long: 400 },
    stagger_ms: { words: 40, items: 40, group_total_max: 400 },
    overshoot_max_pct: 5,
    long_tween_s: 0.8,
  },
  brand_film: {
    ...COMMON,
    signature_ease: NAMED_EASES.premium,
    durations_ms: { short: 300, medium: 500, long: 800 },
    stagger_ms: { words: 80, items: 60, group_total_max: 600 },
    overshoot_max_pct: 0,
    long_tween_s: 2,
  },
  energetic: {
    ...COMMON,
    signature_ease: NAMED_EASES.expo_out,
    durations_ms: { short: 150, medium: 250, long: 400 },
    stagger_ms: { words: 60, items: 40, group_total_max: 500 },
    overshoot_max_pct: 25,
    long_tween_s: 1.2,
  },
  handmade: {
    ...COMMON,
    signature_ease: NAMED_EASES.in_out,
    durations_ms: { short: 250, medium: 500, long: 1000 },
    stagger_ms: { words: 120, items: 100, group_total_max: 1200 },
    overshoot_max_pct: 0,
    // Stepped, hand-made looks hold keys on purpose: monotony and linear checks are relaxed by the caller.
    long_tween_s: 3,
  },
};

/** Fills a (possibly missing or partial) spec from its register's defaults. */
export function resolveMotionSpec(spec?: MotionSpec | null): ResolvedMotionSpec {
  const s = spec ?? {};
  const register: MotionRegister = s.register ?? "brand_film";
  const d = REGISTER_DEFAULTS[register];
  const from: string[] = [];
  const pick = <K extends keyof MotionSpec>(k: K) => {
    if (s[k] !== undefined) from.push(k);
    return s[k];
  };
  const ease = pick("signature_ease");
  const durations = pick("durations_ms");
  const stagger = pick("stagger_ms");
  const reading = pick("reading");
  return {
    register,
    signature_ease: ease === undefined ? d.signature_ease : typeof ease === "string" ? NAMED_EASES[ease] : (ease as [number, number, number, number]),
    durations_ms: { ...d.durations_ms, ...(durations ?? {}) },
    stagger_ms: { ...d.stagger_ms, ...(stagger ?? {}) },
    overshoot_max_pct: pick("overshoot_max_pct") ?? d.overshoot_max_pct,
    exit_ratio: pick("exit_ratio") ?? d.exit_ratio,
    max_same_ease: pick("max_same_ease") ?? d.max_same_ease,
    platform: pick("platform") ?? d.platform,
    min_text_pct: pick("min_text_pct") ?? d.min_text_pct,
    reading: { ...d.reading, ...(reading ?? {}) },
    dead_stretch_s: pick("dead_stretch_s") ?? d.dead_stretch_s,
    long_tween_s: d.long_tween_s,
    facts: pick("facts") ?? [],
    banned: pick("banned") ?? [],
    beats: pick("beats") ?? [],
    from_brief: from,
  };
}

/** Reading time a line of text needs on screen, in seconds. */
export function readingTimeS(text: string, reading: ResolvedMotionSpec["reading"], isLast = false): number {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const t = reading.base_s + reading.per_word_s * words;
  return isLast ? Math.max(t, reading.last_line_s) : t;
}

/** Safe-zone rectangle in comp pixels for a preset. */
export function safeRect(preset: PlatformPreset, width: number, height: number) {
  const p = PLATFORM_PRESETS[preset];
  return {
    left: p.left * width,
    top: p.top * height,
    right: width - p.right * width,
    bottom: height - p.bottom * height,
  };
}

/** Minimum text height in pixels for a comp, from min_text_pct of its short side. */
export function minTextPx(spec: Pick<ResolvedMotionSpec, "min_text_pct">, width: number, height: number): number {
  return (spec.min_text_pct / 100) * Math.min(width, height);
}
