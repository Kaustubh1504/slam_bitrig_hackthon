// Asks the model to direct a mashup; falls back to local rules on any failure.

import { chatJsonSchema } from "./openai.ts";
import {
  fallbackParams,
  type MashupParams,
  PARAM_RANGES,
  parseModelParams,
  type Physics,
  type SourceMeta,
} from "./mashup.ts";

export const DIRECTOR_TIMEOUT_MS = 8000;

export const SYSTEM_PROMPT =
  `You are a mashup director. Given two tracks and the physics of how the user slammed a folding phone shut, decide how to blend them. You cannot hear the audio; use the metadata.
Velocity > 350 deg/s: aggression ≥ 0.8, gains near 1.0, lowpass near 300, reverb_wet ≤ 10, title loud and absurd.
Velocity < 120 deg/s: aggression ≤ 0.3, overlay_gain 0.5–0.7, lowpass near 150, reverb_wet 25–40, title soft and wistful.
In between: interpolate.
Tilt < -0.2: base_track = 'a'. Tilt > 0.2: base_track = 'b'. Otherwise the higher-energy track is the base.
Use overlay_pitch_semitones only if the keys aren't Camelot-adjacent; pick the smallest shift that makes them compatible.
Titles are short, funny, and reference both songs.`;

const range = (key: keyof typeof PARAM_RANGES) => ({
  minimum: PARAM_RANGES[key].min,
  maximum: PARAM_RANGES[key].max,
});

export const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "base_track",
    "tempo_follows",
    "base_gain",
    "overlay_gain",
    "lowpass_hz",
    "highpass_hz",
    "overlay_pitch_semitones",
    "reverb_wet",
    "aggression",
    "title",
    "art_prompt",
  ],
  properties: {
    base_track: { type: "string", enum: ["a", "b"] },
    tempo_follows: { type: "string", enum: ["a", "b"] },
    base_gain: { type: "number", ...range("base_gain") },
    overlay_gain: { type: "number", ...range("overlay_gain") },
    lowpass_hz: { type: "number", ...range("lowpass_hz") },
    highpass_hz: { type: "number", ...range("highpass_hz") },
    overlay_pitch_semitones: { type: "integer", ...range("overlay_pitch_semitones") },
    reverb_wet: { type: "number", ...range("reverb_wet") },
    aggression: { type: "number", ...range("aggression") },
    title: { type: "string" },
    art_prompt: { type: "string" },
  },
};

export type Decision =
  | { source: "model"; params: MashupParams }
  | { source: "fallback"; params: MashupParams; reason: string };

function describeForModel(s: SourceMeta) {
  return {
    type: s.type,
    title: s.title,
    artist: s.artist,
    bpm: s.bpm,
    key_name: s.key_name,
    camelot: s.camelot,
    energy: s.energy,
    description: s.description,
  };
}

/** Never throws: any model failure (HTTP, 8 s timeout, refusal, bad JSON/shape) uses the fallback. */
export async function decideParams(a: SourceMeta, b: SourceMeta, physics: Physics): Promise<Decision> {
  try {
    const raw = await chatJsonSchema({
      system: SYSTEM_PROMPT,
      user: JSON.stringify({ a: describeForModel(a), b: describeForModel(b), physics }),
      schemaName: "mashup_params",
      schema: PARAMS_SCHEMA,
      timeoutMs: DIRECTOR_TIMEOUT_MS,
    });
    const params = parseModelParams(raw);
    if (!params) throw new Error(`Model output did not match the params schema: ${JSON.stringify(raw).slice(0, 300)}`);
    return { source: "model", params };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn("Mashup director failed, using fallback:", reason);
    return { source: "fallback", params: fallbackParams(a, b, physics), reason };
  }
}
