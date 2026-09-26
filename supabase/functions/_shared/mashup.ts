// Pure mashup logic: clamping, tempo math, Camelot key math, and the local fallback.
// No network or env access here, so everything is unit-testable.

export type Side = "a" | "b";
export type ParentType = "track" | "mashup";

export interface Physics {
  velocity_deg_s: number;
  tilt: number;
  contact_angle: number;
  hold_ms?: number;
}

/** A mashup parent (track or earlier mashup) described in track-like terms. */
export interface SourceMeta {
  type: ParentType;
  id: string;
  title: string;
  artist: string | null;
  bpm: number;
  key_name: string | null;
  camelot: string | null;
  energy: number;
  description: string;
}

export interface MashupParams {
  base_track: Side;
  tempo_follows: Side;
  base_gain: number;
  overlay_gain: number;
  lowpass_hz: number;
  highpass_hz: number;
  overlay_pitch_semitones: number;
  reverb_wet: number;
  aggression: number;
  title: string;
  art_prompt: string;
}

export const PARAM_RANGES = {
  base_gain: { min: 0, max: 1 },
  overlay_gain: { min: 0, max: 1 },
  lowpass_hz: { min: 120, max: 300 },
  highpass_hz: { min: 150, max: 500 },
  overlay_pitch_semitones: { min: -2, max: 2 },
  reverb_wet: { min: 0, max: 40 },
  aggression: { min: 0, max: 1 },
} as const;

export type NumericParam = keyof typeof PARAM_RANGES;

export const SLOW_VELOCITY_DEG_S = 120;
export const FAST_VELOCITY_DEG_S = 350;
export const TILT_THRESHOLD = 0.2;
export const STRETCH_MIN = 0.92;
export const STRETCH_MAX = 1.08;
export const FALLBACK_TITLE = "Untitled Collision";

const MAX_TITLE_LENGTH = 80;
const MAX_ART_PROMPT_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

/** Clamp to [min, max]. NaN maps to min so a bad value can never escape the range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampParam(key: NumericParam, value: number): number {
  return clamp(value, PARAM_RANGES[key].min, PARAM_RANGES[key].max);
}

export function clampParams(p: MashupParams): MashupParams {
  return {
    base_track: p.base_track,
    tempo_follows: p.tempo_follows,
    base_gain: clampParam("base_gain", p.base_gain),
    overlay_gain: clampParam("overlay_gain", p.overlay_gain),
    lowpass_hz: clampParam("lowpass_hz", p.lowpass_hz),
    highpass_hz: clampParam("highpass_hz", p.highpass_hz),
    overlay_pitch_semitones: Math.round(clampParam("overlay_pitch_semitones", p.overlay_pitch_semitones)),
    reverb_wet: clampParam("reverb_wet", p.reverb_wet),
    aggression: clampParam("aggression", p.aggression),
    title: p.title.trim().slice(0, MAX_TITLE_LENGTH) || FALLBACK_TITLE,
    art_prompt: p.art_prompt.trim().slice(0, MAX_ART_PROMPT_LENGTH),
  };
}

/**
 * Validate the shape of model output and clamp it. Returns null if anything is
 * missing or mistyped, which the caller treats as "use the fallback".
 */
export function parseModelParams(raw: unknown): MashupParams | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const isSide = (v: unknown): v is Side => v === "a" || v === "b";
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  if (!isSide(r.base_track) || !isSide(r.tempo_follows)) return null;
  if (typeof r.title !== "string" || typeof r.art_prompt !== "string") return null;
  for (const key of Object.keys(PARAM_RANGES) as NumericParam[]) {
    if (!isNum(r[key])) return null;
  }

  return clampParams({
    base_track: r.base_track,
    tempo_follows: r.tempo_follows,
    base_gain: r.base_gain as number,
    overlay_gain: r.overlay_gain as number,
    lowpass_hz: r.lowpass_hz as number,
    highpass_hz: r.highpass_hz as number,
    overlay_pitch_semitones: r.overlay_pitch_semitones as number,
    reverb_wet: r.reverb_wet as number,
    aggression: r.aggression as number,
    title: r.title,
    art_prompt: r.art_prompt,
  });
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export interface TempoResult {
  target_bpm: number;
  /** Playback rate for the track that does NOT set the tempo. */
  stretch_ratio: number;
  warnings: string[];
}

export function computeTempo(tempoFollows: Side, bpmA: number, bpmB: number): TempoResult {
  const targetBpm = tempoFollows === "a" ? bpmA : bpmB;
  const otherBpm = tempoFollows === "a" ? bpmB : bpmA;
  const otherSide: Side = tempoFollows === "a" ? "b" : "a";

  const rawRatio = targetBpm / otherBpm;
  const ratio = clamp(rawRatio, STRETCH_MIN, STRETCH_MAX);
  const warnings: string[] = [];
  if (ratio !== rawRatio) {
    warnings.push(
      `stretch_ratio ${rawRatio.toFixed(3)} is outside ${STRETCH_MIN}–${STRETCH_MAX}; clamped to ${ratio}. ` +
        `Track ${otherSide} will play at ${round(otherBpm * ratio, 1)} BPM instead of ${targetBpm}.`,
    );
  }
  return { target_bpm: targetBpm, stretch_ratio: ratio, warnings };
}

// ---------------------------------------------------------------------------
// Camelot keys
// ---------------------------------------------------------------------------

export interface Camelot {
  num: number; // 1–12
  letter: "A" | "B"; // A = minor, B = major
}

export function parseCamelot(code: string | null | undefined): Camelot | null {
  const m = /^(1[0-2]|[1-9])([AB])$/i.exec(code?.trim() ?? "");
  if (!m) return null;
  return { num: Number(m[1]), letter: m[2].toUpperCase() as "A" | "B" };
}

export function formatCamelot(c: Camelot): string {
  return `${c.num}${c.letter}`;
}

/** Steps around the wheel (number) plus one for switching major/minor. */
export function camelotDistance(x: Camelot, y: Camelot): number {
  const diff = Math.abs(x.num - y.num);
  return Math.min(diff, 12 - diff) + (x.letter === y.letter ? 0 : 1);
}

/** Same key, ±1 on the wheel, or relative major/minor. */
export function isCamelotCompatible(x: Camelot, y: Camelot): boolean {
  return camelotDistance(x, y) <= 1;
}

/** Transposing up one semitone moves 7 steps clockwise on the Camelot wheel. */
export function shiftCamelot(c: Camelot, semitones: number): Camelot {
  const num = ((((c.num - 1 + 7 * semitones) % 12) + 12) % 12) + 1;
  return { num, letter: c.letter };
}

// Preference order: no shift, then the smallest shifts.
const PITCH_CANDIDATES = [0, 1, -1, 2, -2];

/**
 * The smallest overlay pitch shift (within ±2) that brings the overlay closest to
 * the base key. Returns 0 when keys are already compatible or unknown.
 */
export function pickPitchShift(overlayCamelot: string | null, baseCamelot: string | null): number {
  const overlay = parseCamelot(overlayCamelot);
  const base = parseCamelot(baseCamelot);
  if (!overlay || !base) return 0;

  let best = 0;
  let bestDistance = Infinity;
  for (const s of PITCH_CANDIDATES) {
    const d = camelotDistance(shiftCamelot(overlay, s), base);
    if (d < bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Derived mix values (computed deterministically, never by the model)
// ---------------------------------------------------------------------------

export interface MixResult extends TempoResult {
  /** Key of the finished mashup: the base track's key (the overlay is pitched toward it). */
  key_name: string | null;
  camelot: string | null;
  energy: number;
}

export function deriveMix(a: SourceMeta, b: SourceMeta, params: MashupParams): MixResult {
  const tempo = computeTempo(params.tempo_follows, a.bpm, b.bpm);
  const [base, overlay] = params.base_track === "a" ? [a, b] : [b, a];
  const warnings = [...tempo.warnings];

  const baseKey = parseCamelot(base.camelot);
  const overlayKey = parseCamelot(overlay.camelot);
  if (baseKey && overlayKey) {
    const shifted = shiftCamelot(overlayKey, params.overlay_pitch_semitones);
    if (!isCamelotCompatible(shifted, baseKey)) {
      warnings.push(
        `Overlay key ${formatCamelot(overlayKey)} shifted ${params.overlay_pitch_semitones} semitones ` +
          `(${formatCamelot(shifted)}) is not Camelot-compatible with base key ${formatCamelot(baseKey)}.`,
      );
    }
  }

  return {
    ...tempo,
    warnings,
    key_name: base.key_name,
    camelot: base.camelot,
    energy: round((a.energy + b.energy) / 2, 2),
  };
}

// ---------------------------------------------------------------------------
// Fallback: the same rules as the system prompt, computed locally.
// ---------------------------------------------------------------------------

/** 0 at or below a slow close, 1 at or above a hard slam, linear in between. */
export function velocityIntensity(velocityDegS: number): number {
  return clamp(
    (velocityDegS - SLOW_VELOCITY_DEG_S) / (FAST_VELOCITY_DEG_S - SLOW_VELOCITY_DEG_S),
    0,
    1,
  );
}

export function pickBaseTrack(tilt: number, energyA: number, energyB: number): Side {
  if (tilt < -TILT_THRESHOLD) return "a";
  if (tilt > TILT_THRESHOLD) return "b";
  return energyB > energyA ? "b" : "a";
}

// [slow close, hard slam] endpoints; values in between are linearly interpolated.
export const FALLBACK_CURVE = {
  base_gain: [0.8, 1.0],
  overlay_gain: [0.6, 0.95],
  lowpass_hz: [150, 300],
  highpass_hz: [350, 200],
  reverb_wet: [35, 5],
  aggression: [0.2, 0.9],
} as const satisfies Partial<Record<NumericParam, readonly [number, number]>>;

function curve(key: keyof typeof FALLBACK_CURVE, t: number): number {
  const [slow, fast] = FALLBACK_CURVE[key];
  return slow + (fast - slow) * t;
}

export function fallbackParams(a: SourceMeta, b: SourceMeta, physics: Physics): MashupParams {
  const t = velocityIntensity(physics.velocity_deg_s);
  const baseTrack = pickBaseTrack(physics.tilt, a.energy, b.energy);
  const [base, overlay] = baseTrack === "a" ? [a, b] : [b, a];

  return clampParams({
    base_track: baseTrack,
    tempo_follows: baseTrack,
    base_gain: round(curve("base_gain", t), 2),
    overlay_gain: round(curve("overlay_gain", t), 2),
    lowpass_hz: Math.round(curve("lowpass_hz", t)),
    highpass_hz: Math.round(curve("highpass_hz", t)),
    overlay_pitch_semitones: pickPitchShift(overlay.camelot, base.camelot),
    reverb_wet: Math.round(curve("reverb_wet", t)),
    aggression: round(curve("aggression", t), 2),
    title: FALLBACK_TITLE,
    art_prompt: fallbackArtPrompt(a, b, t),
  });
}

function fallbackArtPrompt(a: SourceMeta, b: SourceMeta, intensity: number): string {
  const describe = (s: SourceMeta) => `"${s.title}"${s.artist ? ` by ${s.artist}` : ""}`;
  const mood = intensity >= 0.5
    ? "explosive and loud, shattered neon shards, high contrast"
    : "soft and wistful, hazy pastel light, gentle grain";
  return `Album cover art for a collision of ${describe(a)} and ${describe(b)}: ${mood}. No text.`;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
