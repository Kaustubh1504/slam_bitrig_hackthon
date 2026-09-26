Build a Supabase backend for a hackathon iOS app called SLAM. The app mixes two songs on-device with AVAudioEngine; this backend never touches audio. It stores the song catalog, asks OpenAI to decide the mashup settings, records every mashup, and serves a realtime feed.

Use the Supabase CLI project structure: SQL migrations in supabase/migrations, Edge Functions in TypeScript (Deno) in supabase/functions, and a seed file. Read OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_IMAGE_MODEL from environment secrets. Never hardcode keys or model names.

## Database (one migration)

tracks
- id text primary key (e.g. "september-ewf")
- title, artist, itunes_search_term text
- bpm numeric, key_name text, camelot text
- downbeat_offset_sec numeric default 0
- energy numeric (0–1), description text (e.g. "bass-forward disco groove, falsetto vocals")
- preview_url text nullable, created_at timestamptz default now()

pairs
- id text primary key, track_a text references tracks, track_b text references tracks
- featured boolean default true, sort_order int

mashups
- id uuid primary key default gen_random_uuid()
- parent_a_type text check in ('track','mashup'), parent_a_id text
- parent_b_type text check in ('track','mashup'), parent_b_id text
- physics jsonb, params jsonb
- params_source text check in ('model','fallback')
- title text, art_prompt text, art_url text nullable
- device_name text, created_at timestamptz default now()

Parents can be tracks or earlier mashups, so chaining forms a lineage graph. Add a SQL function get_lineage(mashup_id uuid) that recursively returns all ancestors.

RLS: enable on all tables. Anonymous users can SELECT everything. Only Edge Functions (service role) can INSERT or UPDATE.
Enable Realtime on the mashups table.
Create a public Storage bucket named "covers".

## Seed data
Tracks:
- september-ewf: "September", Earth, Wind & Fire, 126 BPM, A major, 11B, energy 0.6, "bass-forward disco groove, horns, joyful group vocals"
- right-round-flo-rida: "Right Round", Flo Rida, 123 BPM, G, 9B, energy 0.85, "electro-pop rap, big synth hook, Kesha chorus"
- dracula-tame-impala: "Dracula", Tame Impala, 115 BPM, E♭ minor, 2A, energy 0.5, "groovy disco-electropop, deep bassline, airy vocals"
- man-i-need-olivia-dean: "Man I Need", Olivia Dean, 119 BPM, D♭ major, 3B, energy 0.45, "warm soul-pop, bass-heavy, rich lead vocal"
Pairs: september × right-round, dracula × man-i-need.

## Edge Function: catalog (GET)
Returns featured pairs with both tracks' full metadata. For any track with no preview_url, look it up via the iTunes Search API (https://itunes.apple.com/search?term=<term>&entity=song&limit=1), save the previewUrl to the tracks table, and include it. If iTunes fails, return the track with preview_url null instead of erroring.

## Edge Function: direct-mashup (POST)
Input:
{
  "parent_a": {"type": "track"|"mashup", "id": "..."},
  "parent_b": {"type": "track"|"mashup", "id": "..."},
  "physics": {"velocity_deg_s": number, "tilt": number, "contact_angle": number, "hold_ms": number (optional)},
  "device_name": string
}

Steps:
1. Load both parents' metadata. For a mashup parent, use its title, the target BPM and key from its params, and describe it as a mashup of its parents.
2. Call OpenAI Chat Completions with structured outputs (response_format type json_schema, strict: true) using this schema:
   base_track "a"|"b", tempo_follows "a"|"b", base_gain 0–1, overlay_gain 0–1, lowpass_hz 120–300, highpass_hz 150–500, overlay_pitch_semitones -2 to 2 (integer), reverb_wet 0–40, aggression 0–1, title string, art_prompt string.
3. System prompt:
   "You are a mashup director. Given two tracks and the physics of how the user slammed a folding phone shut, decide how to blend them. You cannot hear the audio; use the metadata.
   Velocity > 350 deg/s: aggression ≥ 0.8, gains near 1.0, lowpass near 300, reverb_wet ≤ 10, title loud and absurd.
   Velocity < 120 deg/s: aggression ≤ 0.3, overlay_gain 0.5–0.7, lowpass near 150, reverb_wet 25–40, title soft and wistful.
   In between: interpolate.
   Tilt < -0.2: base_track = 'a'. Tilt > 0.2: base_track = 'b'. Otherwise the higher-energy track is the base.
   Use overlay_pitch_semitones only if the keys aren't Camelot-adjacent; pick the smallest shift that makes them compatible.
   Titles are short, funny, and reference both songs."
   User message: both tracks' metadata and the physics, as JSON.
4. Clamp every numeric value to its range, even though the schema should prevent violations.
5. Compute deterministically (not by the model): target_bpm = the BPM of the tempo_follows track, stretch_ratio = target_bpm / other track's BPM. If the ratio is outside 0.92–1.08, clamp it and add a warning field.
6. Fallback: if OpenAI errors, times out (8 seconds), or returns invalid JSON, compute params locally from the same rules (velocity → aggression and gains, tilt → base_track), with the title "Untitled Collision" and params_source "fallback". The function must always return usable params.
7. Insert a mashups row. Return {mashup_id, params, target_bpm, stretch_ratio, params_source, warnings}.
8. Kick off cover art generation in the background (EdgeRuntime.waitUntil) without making the response wait.

## Edge Function: generate-art
Given a mashup_id, generate a square image from its art_prompt with the OpenAI Images API, upload it to the covers bucket as <mashup_id>.png, and set art_url. Also callable directly with POST {mashup_id} so I can retry failures.

## Quality
- Shared code (Supabase client, OpenAI client, clamping, fallback) in supabase/functions/_shared.
- Validate all inputs and return clear 400 errors.
- Handle CORS.
- Unit tests (Deno test) for clamping, the stretch-ratio math, and the fallback mapping.
- A README with: setup steps (supabase start, db reset, secrets set, functions serve), deploy commands, and curl examples for every function, including a slow close and a fast slam on the same pair.