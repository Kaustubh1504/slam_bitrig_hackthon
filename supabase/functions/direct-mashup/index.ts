// POST /direct-mashup — decide mashup params for two parents plus slam physics,
// record the mashup, and start cover art generation in the background.

import { generateArt } from "../_shared/art.ts";
import { decideParams } from "../_shared/director.ts";
import { HttpError, json, readJsonBody, serve } from "../_shared/http.ts";
import { deriveMix } from "../_shared/mashup.ts";
import { loadSource } from "../_shared/sources.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { validateDirectMashupInput } from "../_shared/validate.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function runInBackground(promise: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(promise);
}

serve(["POST"], async (req) => {
  const input = validateDirectMashupInput(await readJsonBody(req));
  if (!input.ok) throw new HttpError(400, "Invalid request body", input.errors);
  const { parent_a, parent_b, physics, device_name } = input.value;

  const db = serviceClient();
  const [a, b] = await Promise.all([
    loadSource(db, parent_a, "parent_a"),
    loadSource(db, parent_b, "parent_b"),
  ]);

  const decision = await decideParams(a, b, physics);
  const mix = deriveMix(a, b, decision.params);
  const warnings = decision.source === "fallback"
    ? ["Mashup director unavailable; used fallback params", ...mix.warnings]
    : mix.warnings;

  // Derived values live alongside the model's params so a later mashup can use
  // this one as a parent (it needs target_bpm, key, and energy).
  const params = {
    ...decision.params,
    target_bpm: mix.target_bpm,
    stretch_ratio: mix.stretch_ratio,
    key_name: mix.key_name,
    camelot: mix.camelot,
    energy: mix.energy,
  };

  const { data: row, error } = await db
    .from("mashups")
    .insert({
      parent_a_type: parent_a.type,
      parent_a_id: parent_a.id,
      parent_b_type: parent_b.type,
      parent_b_id: parent_b.id,
      physics,
      params,
      params_source: decision.source,
      title: params.title,
      art_prompt: params.art_prompt,
      device_name,
    })
    .select("id")
    .single();
  if (error) throw error;

  runInBackground(
    generateArt(db, row.id).catch((err) => console.error(`Cover art for ${row.id} failed:`, err)),
  );

  return json({
    mashup_id: row.id,
    params,
    target_bpm: mix.target_bpm,
    stretch_ratio: mix.stretch_ratio,
    params_source: decision.source,
    warnings,
  });
});
