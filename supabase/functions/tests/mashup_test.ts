import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  clamp,
  clampParams,
  computeTempo,
  deriveMix,
  FALLBACK_TITLE,
  fallbackParams,
  type MashupParams,
  PARAM_RANGES,
  parseModelParams,
  pickBaseTrack,
  pickPitchShift,
  shiftCamelot,
  type SourceMeta,
  velocityIntensity,
} from "../_shared/mashup.ts";
import { validateDirectMashupInput, validateGenerateArtInput } from "../_shared/validate.ts";

// Seed tracks
const september: SourceMeta = {
  type: "track", id: "september-ewf", title: "September", artist: "Earth, Wind & Fire",
  bpm: 126, key_name: "A major", camelot: "11B", energy: 0.6,
  description: "bass-forward disco groove, horns, joyful group vocals",
};
const rightRound: SourceMeta = {
  type: "track", id: "right-round-flo-rida", title: "Right Round", artist: "Flo Rida",
  bpm: 123, key_name: "G major", camelot: "9B", energy: 0.85,
  description: "electro-pop rap, big synth hook, Kesha chorus",
};
const dracula: SourceMeta = {
  type: "track", id: "dracula-tame-impala", title: "Dracula", artist: "Tame Impala",
  bpm: 115, key_name: "E♭ minor", camelot: "2A", energy: 0.5,
  description: "groovy disco-electropop, deep bassline, airy vocals",
};
const manINeed: SourceMeta = {
  type: "track", id: "man-i-need-olivia-dean", title: "Man I Need", artist: "Olivia Dean",
  bpm: 119, key_name: "D♭ major", camelot: "3B", energy: 0.45,
  description: "warm soul-pop, bass-heavy, rich lead vocal",
};

const validParams: MashupParams = {
  base_track: "a", tempo_follows: "a", base_gain: 0.9, overlay_gain: 0.7, lowpass_hz: 200,
  highpass_hz: 300, overlay_pitch_semitones: 0, reverb_wet: 20, aggression: 0.5,
  title: "Septemround", art_prompt: "disco ball spinning off its axis",
};

function assertInRanges(p: MashupParams) {
  for (const [key, { min, max }] of Object.entries(PARAM_RANGES)) {
    const v = p[key as keyof typeof PARAM_RANGES];
    assert(v >= min && v <= max, `${key}=${v} outside ${min}–${max}`);
  }
  assert(Number.isInteger(p.overlay_pitch_semitones));
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

Deno.test("clamp keeps in-range values and pins out-of-range ones", () => {
  assertEquals(clamp(0.5, 0, 1), 0.5);
  assertEquals(clamp(-3, 0, 1), 0);
  assertEquals(clamp(7, 0, 1), 1);
  assertEquals(clamp(Infinity, 120, 300), 300);
  assertEquals(clamp(-Infinity, 120, 300), 120);
  assertEquals(clamp(NaN, 120, 300), 120);
});

Deno.test("clampParams pins every numeric field to its range", () => {
  const p = clampParams({
    ...validParams,
    base_gain: 1.4, overlay_gain: -0.2, lowpass_hz: 50, highpass_hz: 9000,
    overlay_pitch_semitones: -7, reverb_wet: 99, aggression: 2,
  });
  assertEquals(p.base_gain, 1);
  assertEquals(p.overlay_gain, 0);
  assertEquals(p.lowpass_hz, 120);
  assertEquals(p.highpass_hz, 500);
  assertEquals(p.overlay_pitch_semitones, -2);
  assertEquals(p.reverb_wet, 40);
  assertEquals(p.aggression, 1);
});

Deno.test("clampParams rounds pitch to an integer and tidies strings", () => {
  const p = clampParams({ ...validParams, overlay_pitch_semitones: 1.6, title: "   ", art_prompt: "  x  " });
  assertEquals(p.overlay_pitch_semitones, 2);
  assertEquals(p.title, FALLBACK_TITLE);
  assertEquals(p.art_prompt, "x");
  assertEquals(clampParams({ ...validParams, title: "t".repeat(500) }).title.length, 80);
});

Deno.test("parseModelParams accepts valid output and clamps it", () => {
  const p = parseModelParams({ ...validParams, lowpass_hz: 999, extra: "ignored" });
  assert(p);
  assertEquals(p.lowpass_hz, 300);
  assertEquals("extra" in p, false);
});

Deno.test("parseModelParams rejects wrong shapes", () => {
  assertEquals(parseModelParams(null), null);
  assertEquals(parseModelParams([]), null);
  assertEquals(parseModelParams("{}"), null);
  assertEquals(parseModelParams({ ...validParams, base_track: "c" }), null);
  assertEquals(parseModelParams({ ...validParams, aggression: "high" }), null);
  const { title: _title, ...missingTitle } = validParams;
  assertEquals(parseModelParams(missingTitle), null);
});

// ---------------------------------------------------------------------------
// Stretch ratio
// ---------------------------------------------------------------------------

Deno.test("stretch ratio: tempo follows a", () => {
  const t = computeTempo("a", 126, 123);
  assertEquals(t.target_bpm, 126);
  assertAlmostEquals(t.stretch_ratio, 126 / 123, 1e-12);
  assertEquals(t.warnings, []);
});

Deno.test("stretch ratio: tempo follows b", () => {
  const t = computeTempo("b", 126, 123);
  assertEquals(t.target_bpm, 123);
  assertAlmostEquals(t.stretch_ratio, 123 / 126, 1e-12);
  assertEquals(t.warnings, []);
});

Deno.test("stretch ratio: exact boundaries are not clamped", () => {
  assertEquals(computeTempo("a", 108, 100).stretch_ratio, 1.08);
  assertEquals(computeTempo("a", 108, 100).warnings, []);
  assertEquals(computeTempo("a", 92, 100).stretch_ratio, 0.92);
  assertEquals(computeTempo("a", 92, 100).warnings, []);
});

Deno.test("stretch ratio above 1.08 is clamped with a warning", () => {
  const t = computeTempo("a", 140, 100);
  assertEquals(t.target_bpm, 140);
  assertEquals(t.stretch_ratio, 1.08);
  assertEquals(t.warnings.length, 1);
  assert(t.warnings[0].includes("1.400"));
  assert(t.warnings[0].includes("108 BPM"));
});

Deno.test("stretch ratio below 0.92 is clamped with a warning", () => {
  const t = computeTempo("b", 100, 70);
  assertEquals(t.target_bpm, 70);
  assertEquals(t.stretch_ratio, 0.92);
  assertEquals(t.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Camelot
// ---------------------------------------------------------------------------

Deno.test("shiftCamelot: +1 semitone is +7 on the wheel, wrapping 12 -> 1", () => {
  assertEquals(shiftCamelot({ num: 8, letter: "B" }, 1), { num: 3, letter: "B" }); // C -> C#
  assertEquals(shiftCamelot({ num: 9, letter: "B" }, 2), { num: 11, letter: "B" }); // G -> A
  assertEquals(shiftCamelot({ num: 11, letter: "B" }, -2), { num: 9, letter: "B" }); // A -> G
  assertEquals(shiftCamelot({ num: 5, letter: "A" }, 0), { num: 5, letter: "A" });
});

Deno.test("pickPitchShift: none when already compatible", () => {
  assertEquals(pickPitchShift("8B", "8B"), 0);
  assertEquals(pickPitchShift("8B", "9B"), 0);
  assertEquals(pickPitchShift("8A", "8B"), 0);
  assertEquals(pickPitchShift("12B", "1B"), 0);
});

Deno.test("pickPitchShift: September x Right Round needs two semitones", () => {
  assertEquals(pickPitchShift("9B", "11B"), 2); // Right Round over September
  assertEquals(pickPitchShift("11B", "9B"), -2); // September over Right Round
});

Deno.test("pickPitchShift: unknown keys mean no shift", () => {
  assertEquals(pickPitchShift(null, "8B"), 0);
  assertEquals(pickPitchShift("8B", "not-a-key"), 0);
});

// ---------------------------------------------------------------------------
// Fallback mapping
// ---------------------------------------------------------------------------

Deno.test("velocityIntensity maps slow→0, fast→1, linear between", () => {
  assertEquals(velocityIntensity(0), 0);
  assertEquals(velocityIntensity(120), 0);
  assertEquals(velocityIntensity(235), 0.5);
  assertEquals(velocityIntensity(350), 1);
  assertEquals(velocityIntensity(900), 1);
});

Deno.test("pickBaseTrack: tilt wins, otherwise higher energy, ties go to a", () => {
  assertEquals(pickBaseTrack(-0.5, 0.1, 0.9), "a");
  assertEquals(pickBaseTrack(0.5, 0.9, 0.1), "b");
  assertEquals(pickBaseTrack(-0.2, 0.1, 0.9), "b"); // threshold is exclusive
  assertEquals(pickBaseTrack(0.2, 0.9, 0.1), "a");
  assertEquals(pickBaseTrack(0, 0.6, 0.85), "b");
  assertEquals(pickBaseTrack(0, 0.5, 0.45), "a");
  assertEquals(pickBaseTrack(0, 0.5, 0.5), "a");
});

Deno.test("fallback: fast slam follows the loud rules", () => {
  const p = fallbackParams(september, rightRound, { velocity_deg_s: 520, tilt: 0, contact_angle: 3 });
  assertInRanges(p);
  assert(p.aggression >= 0.8);
  assert(p.base_gain >= 0.95 && p.overlay_gain >= 0.9);
  assertEquals(p.lowpass_hz, 300);
  assert(p.reverb_wet <= 10);
  assertEquals(p.title, FALLBACK_TITLE);
  assertEquals(p.base_track, "b"); // Right Round has more energy
  assertEquals(p.tempo_follows, "b");
  assertEquals(p.overlay_pitch_semitones, -2); // September 11B -> 9B
});

Deno.test("fallback: slow close follows the soft rules", () => {
  const p = fallbackParams(september, rightRound, { velocity_deg_s: 60, tilt: -0.6, contact_angle: 1, hold_ms: 900 });
  assertInRanges(p);
  assert(p.aggression <= 0.3);
  assert(p.overlay_gain >= 0.5 && p.overlay_gain <= 0.7);
  assertEquals(p.lowpass_hz, 150);
  assert(p.reverb_wet >= 25 && p.reverb_wet <= 40);
  assertEquals(p.base_track, "a"); // tilt < -0.2
  assertEquals(p.overlay_pitch_semitones, 2); // Right Round 9B -> 11B
});

Deno.test("fallback: medium velocity interpolates between the extremes", () => {
  const slow = fallbackParams(dracula, manINeed, { velocity_deg_s: 100, tilt: 0.5, contact_angle: 0 });
  const mid = fallbackParams(dracula, manINeed, { velocity_deg_s: 235, tilt: 0.5, contact_angle: 0 });
  const fast = fallbackParams(dracula, manINeed, { velocity_deg_s: 400, tilt: 0.5, contact_angle: 0 });
  assertInRanges(mid);
  assertEquals(mid.base_track, "b"); // tilt > 0.2
  assert(slow.aggression < mid.aggression && mid.aggression < fast.aggression);
  assert(slow.lowpass_hz < mid.lowpass_hz && mid.lowpass_hz < fast.lowpass_hz);
  assert(slow.reverb_wet > mid.reverb_wet && mid.reverb_wet > fast.reverb_wet);
  assertAlmostEquals(mid.aggression, 0.55, 1e-9);
  assertEquals(mid.lowpass_hz, 225);
});

// ---------------------------------------------------------------------------
// Derived mix
// ---------------------------------------------------------------------------

Deno.test("deriveMix: key comes from the base, energy is the parents' mean", () => {
  const mix = deriveMix(september, rightRound, {
    ...validParams, base_track: "b", tempo_follows: "b", overlay_pitch_semitones: -2,
  });
  assertEquals(mix.target_bpm, 123);
  assertAlmostEquals(mix.stretch_ratio, 123 / 126, 1e-12);
  assertEquals(mix.camelot, "9B");
  assertEquals(mix.key_name, "G major");
  assertEquals(mix.energy, 0.73);
  assertEquals(mix.warnings, []);
});

Deno.test("deriveMix warns when the keys still clash after the pitch shift", () => {
  const mix = deriveMix(september, rightRound, { ...validParams, overlay_pitch_semitones: 0 });
  assertEquals(mix.warnings.length, 1);
  assert(mix.warnings[0].includes("not Camelot-compatible"));
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const validBody = {
  parent_a: { type: "track", id: "september-ewf" },
  parent_b: { type: "track", id: "right-round-flo-rida" },
  physics: { velocity_deg_s: 400, tilt: 0.1, contact_angle: 2, extra: "dropped" },
  device_name: "Galaxy Z Flip",
};

Deno.test("validateDirectMashupInput accepts a valid body and drops unknown physics keys", () => {
  const r = validateDirectMashupInput(validBody);
  assert(r.ok);
  assertEquals(r.value.physics, { velocity_deg_s: 400, tilt: 0.1, contact_angle: 2 });
});

Deno.test("validateDirectMashupInput reports every problem", () => {
  const r = validateDirectMashupInput({
    parent_a: { type: "song", id: "" },
    parent_b: { type: "mashup", id: "not-a-uuid" },
    physics: { velocity_deg_s: -5, tilt: "left", hold_ms: -1 },
  });
  assert(!r.ok);
  assertEquals(r.errors.length, 8);
});

Deno.test("validateDirectMashupInput rejects identical parents and non-objects", () => {
  const same = validateDirectMashupInput({ ...validBody, parent_b: validBody.parent_a });
  assert(!same.ok);
  assert(same.errors[0].includes("must be different"));
  assert(!validateDirectMashupInput([]).ok);
  assert(!validateDirectMashupInput(null).ok);
});

Deno.test("validateGenerateArtInput requires a UUID", () => {
  assert(validateGenerateArtInput({ mashup_id: "0b6f7e6c-2a52-4a55-9a36-3f1f0a4d8c11" }).ok);
  assert(!validateGenerateArtInput({ mashup_id: "abc" }).ok);
  assert(!validateGenerateArtInput({ mashup_id: "0b6f7e6c-2a52-4a55-9a36-3f1f0a4d8c11", force: "yes" }).ok);
});
