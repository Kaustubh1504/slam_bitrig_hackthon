// Loads a mashup parent (track or earlier mashup) as track-like metadata.

import { HttpError } from "./http.ts";
import type { SourceMeta } from "./mashup.ts";
import type { SupabaseClient } from "./supabase.ts";
import type { ParentRef } from "./validate.ts";

async function loadTitle(db: SupabaseClient, ref: ParentRef): Promise<string> {
  const table = ref.type === "track" ? "tracks" : "mashups";
  const { data, error } = await db.from(table).select("title").eq("id", ref.id).maybeSingle();
  if (error) throw error;
  return data?.title ?? "an unknown song";
}

async function loadTrack(db: SupabaseClient, id: string, field: string): Promise<SourceMeta> {
  const { data, error } = await db
    .from("tracks")
    .select("id, title, artist, bpm, key_name, camelot, energy, description")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, `${field}: track "${id}" not found`);

  return {
    type: "track",
    id: data.id,
    title: data.title,
    artist: data.artist,
    bpm: Number(data.bpm),
    key_name: data.key_name,
    camelot: data.camelot,
    energy: Number(data.energy),
    description: data.description,
  };
}

async function loadMashup(db: SupabaseClient, id: string, field: string): Promise<SourceMeta> {
  const { data, error } = await db
    .from("mashups")
    .select("id, title, params, parent_a_type, parent_a_id, parent_b_type, parent_b_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, `${field}: mashup "${id}" not found`);

  const params = (data.params ?? {}) as Record<string, unknown>;
  const bpm = Number(params.target_bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new HttpError(422, `${field}: mashup "${id}" has no usable target_bpm in its params`);
  }

  const [titleA, titleB] = await Promise.all([
    loadTitle(db, { type: data.parent_a_type, id: data.parent_a_id }),
    loadTitle(db, { type: data.parent_b_type, id: data.parent_b_id }),
  ]);
  const energy = Number(params.energy);

  return {
    type: "mashup",
    id: data.id,
    title: data.title,
    artist: null,
    bpm,
    key_name: typeof params.key_name === "string" ? params.key_name : null,
    camelot: typeof params.camelot === "string" ? params.camelot : null,
    energy: Number.isFinite(energy) ? energy : 0.5,
    description: `a mashup of "${titleA}" and "${titleB}"`,
  };
}

export function loadSource(db: SupabaseClient, ref: ParentRef, field: string): Promise<SourceMeta> {
  return ref.type === "track" ? loadTrack(db, ref.id, field) : loadMashup(db, ref.id, field);
}
