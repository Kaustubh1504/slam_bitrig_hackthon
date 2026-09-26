// Cover art: generate from a mashup's art_prompt, upload to the covers bucket, save art_url.

import { HttpError } from "./http.ts";
import { generateImagePng } from "./openai.ts";
import type { SupabaseClient } from "./supabase.ts";

export const COVERS_BUCKET = "covers";
const IMAGE_TIMEOUT_MS = 120_000;

/**
 * Locally, SUPABASE_URL inside the edge runtime is the Docker-internal http://kong:8000,
 * which devices can't reach. PUBLIC_SUPABASE_URL (optional) swaps in a reachable origin.
 * Hosted projects leave it unset: SUPABASE_URL is already public there.
 */
function withPublicOrigin(url: string): string {
  const publicBase = Deno.env.get("PUBLIC_SUPABASE_URL");
  if (!publicBase) return url;
  const { pathname } = new URL(url);
  return new URL(pathname, publicBase).toString();
}

export interface ArtResult {
  art_url: string;
  /** false when existing art was returned without calling OpenAI. */
  generated: boolean;
}

export async function generateArt(
  db: SupabaseClient,
  mashupId: string,
  { force = false }: { force?: boolean } = {},
): Promise<ArtResult> {
  const { data: mashup, error } = await db
    .from("mashups")
    .select("id, title, art_prompt, art_url")
    .eq("id", mashupId)
    .maybeSingle();
  if (error) throw error;
  if (!mashup) throw new HttpError(404, `Mashup "${mashupId}" not found`);
  if (mashup.art_url && !force) return { art_url: mashup.art_url, generated: false };

  const prompt = `Square album cover. ${mashup.art_prompt || `Cover art for a mashup titled "${mashup.title}".`}`;
  const png = await generateImagePng(prompt, IMAGE_TIMEOUT_MS);

  const path = `${mashup.id}.png`;
  const { error: uploadError } = await db.storage
    .from(COVERS_BUCKET)
    .upload(path, png, { contentType: "image/png", upsert: true });
  if (uploadError) throw uploadError;

  // Version the URL so clients and the CDN don't keep showing a previous attempt.
  const { data: { publicUrl } } = db.storage.from(COVERS_BUCKET).getPublicUrl(path);
  const artUrl = `${withPublicOrigin(publicUrl)}?v=${Date.now()}`;

  const { error: updateError } = await db.from("mashups").update({ art_url: artUrl }).eq("id", mashup.id);
  if (updateError) throw updateError;

  return { art_url: artUrl, generated: true };
}
