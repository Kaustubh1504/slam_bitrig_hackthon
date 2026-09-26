// GET /catalog — featured pairs with full metadata for both tracks.
// Fills in missing preview URLs from the iTunes Search API and saves them.

import { json, serve } from "../_shared/http.ts";
import { serviceClient, type SupabaseClient } from "../_shared/supabase.ts";

const ITUNES_TIMEOUT_MS = 5000;

interface TrackRow {
  id: string;
  itunes_search_term: string;
  preview_url: string | null;
  [column: string]: unknown;
}

async function lookupItunesPreview(term: string): Promise<string | null> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`iTunes search returned ${res.status}`);
  const previewUrl = (await res.json())?.results?.[0]?.previewUrl;
  return typeof previewUrl === "string" ? previewUrl : null;
}

/** Never throws: on any iTunes or database failure the track keeps preview_url null. */
async function fillPreviewUrl(db: SupabaseClient, track: TrackRow): Promise<void> {
  try {
    const previewUrl = await lookupItunesPreview(track.itunes_search_term);
    if (!previewUrl) return;
    track.preview_url = previewUrl;
    const { error } = await db.from("tracks").update({ preview_url: previewUrl }).eq("id", track.id);
    if (error) console.error(`Saving preview_url for ${track.id} failed:`, error);
  } catch (err) {
    console.warn(`iTunes lookup for ${track.id} failed:`, err);
  }
}

serve(["GET"], async () => {
  const db = serviceClient();

  const { data: pairs, error: pairsError } = await db
    .from("pairs")
    .select("id, track_a, track_b, sort_order")
    .eq("featured", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("id");
  if (pairsError) throw pairsError;

  const trackIds = [...new Set(pairs.flatMap((p) => [p.track_a, p.track_b]))];
  const { data: tracks, error: tracksError } = await db.from("tracks").select("*").in("id", trackIds);
  if (tracksError) throw tracksError;

  const rows = tracks as TrackRow[];
  await Promise.all(rows.filter((t) => !t.preview_url).map((t) => fillPreviewUrl(db, t)));

  const byId = new Map(rows.map((t) => [t.id, t]));
  return json({
    pairs: pairs.map((p) => ({
      id: p.id,
      sort_order: p.sort_order,
      track_a: byId.get(p.track_a),
      track_b: byId.get(p.track_b),
    })),
  });
});
