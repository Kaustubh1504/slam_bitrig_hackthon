# SLAM backend (Supabase)

Backend for SLAM, an iOS app that mixes two songs on-device with AVAudioEngine when you slam a folding phone shut. This backend never touches audio. It:

- stores the song catalog and featured pairs (`catalog` fills in iTunes preview URLs),
- asks OpenAI to direct each mashup from track metadata plus slam physics (`direct-mashup`), with a local fallback so it always returns usable params,
- records every mashup. Parents can be tracks or earlier mashups, so mashups form a lineage graph (`get_lineage`),
- generates cover art into the public `covers` bucket (`generate-art`),
- serves a realtime feed of the `mashups` table.

```
supabase/
  config.toml
  migrations/20260926000000_slam_init.sql   tables, RLS, get_lineage, realtime, covers bucket
  seed.sql                                  4 tracks, 2 featured pairs
  functions/
    _shared/        http/CORS, Supabase client, OpenAI client, clamping + fallback, validation
    catalog/        GET
    direct-mashup/  POST
    generate-art/   POST
    tests/          Deno unit tests
```

## Setup (local)

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli), Docker, and (for the tests) [Deno](https://deno.com).

```sh
supabase start                 # boots Postgres, API, Storage, Realtime, Edge Runtime
supabase db reset              # applies the migration and seed.sql (re-run any time)

cp supabase/functions/.env.example supabase/functions/.env
# fill in OPENAI_API_KEY, OPENAI_MODEL, OPENAI_IMAGE_MODEL

supabase functions serve --env-file supabase/functions/.env
```

`OPENAI_MODEL` must support Structured Outputs (`response_format: json_schema`). `OPENAI_IMAGE_MODEL` can be a GPT image model or a DALL·E model; both are handled. If the OpenAI values are missing, `direct-mashup` still works by using the fallback, and cover art fails until they're set.

`PUBLIC_SUPABASE_URL` is for local development only. Inside the local edge runtime, Supabase is at the Docker-internal `http://kong:8000`, which a phone can't reach. This setting makes saved `art_url`s use a reachable address instead: `http://127.0.0.1:54321` for the simulator, or `http://<your Mac's LAN IP>:54321` for a physical iPhone. Don't set it on the hosted project.

Grab the local URL and anon key for the curl examples below:

```sh
eval "$(supabase status -o env)"          # sets API_URL, ANON_KEY, ...
export FN="$API_URL/functions/v1"
```

Run the unit tests (clamping, stretch-ratio math, fallback mapping, Camelot math, input validation):

```sh
cd supabase/functions && deno test tests/
```

## Deploy

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --include-seed                   # apply the migration and seed.sql

supabase secrets set OPENAI_API_KEY=sk-... OPENAI_MODEL=<chat-model> OPENAI_IMAGE_MODEL=<image-model>
supabase functions deploy catalog
supabase functions deploy direct-mashup
supabase functions deploy generate-art
```

For the hosted project, set `API_URL`/`ANON_KEY` from Project Settings → API, then `export FN="$API_URL/functions/v1"`.

The functions keep the default `verify_jwt = true`, so callers must send the project's anon key (a JWT) as `Authorization: Bearer`. The iOS Supabase SDK does this automatically.

## API

Every function answers CORS preflight and returns JSON. Errors look like `{"error": "...", "details": [...]}` with status 400 (bad input), 404 (unknown parent/mashup), 405 (wrong method), or 502 (cover art generation failed).

### `GET /catalog`

Returns the featured pairs in `sort_order` with both tracks' full rows. A track without a `preview_url` is looked up on the iTunes Search API, and the result is saved. If iTunes fails, the track comes back with `preview_url: null`.

```sh
curl -s "$FN/catalog" -H "Authorization: Bearer $ANON_KEY"
```

### `POST /direct-mashup`

The same pair, closed two ways. **Slow close** (soft, wistful, reverb-heavy; tilt picks September as base):

```sh
curl -s "$FN/direct-mashup" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{
    "parent_a": {"type": "track", "id": "september-ewf"},
    "parent_b": {"type": "track", "id": "right-round-flo-rida"},
    "physics": {"velocity_deg_s": 70, "tilt": -0.4, "contact_angle": 0.5, "hold_ms": 1200},
    "device_name": "Pixel Fold"
  }'
```

**Fast slam** (loud, dry, aggressive; flat tilt, so the higher-energy Right Round is base):

```sh
curl -s "$FN/direct-mashup" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{
    "parent_a": {"type": "track", "id": "september-ewf"},
    "parent_b": {"type": "track", "id": "right-round-flo-rida"},
    "physics": {"velocity_deg_s": 480, "tilt": 0.05, "contact_angle": 2.5},
    "device_name": "Pixel Fold"
  }'
```

Response:

```json
{
  "mashup_id": "571533a8-26fc-4998-97e1-e3a3e5a2961d",
  "params": {
    "base_track": "b", "tempo_follows": "b",
    "base_gain": 1, "overlay_gain": 0.95,
    "lowpass_hz": 300, "highpass_hz": 200,
    "overlay_pitch_semitones": -2, "reverb_wet": 5, "aggression": 0.9,
    "title": "...", "art_prompt": "...",
    "target_bpm": 123, "stretch_ratio": 0.976, "key_name": "G major", "camelot": "9B", "energy": 0.73
  },
  "target_bpm": 123,
  "stretch_ratio": 0.9761904761904762,
  "params_source": "model",
  "warnings": []
}
```

**Chain** a mashup with another track (or another mashup) by passing its id as a parent:

```sh
curl -s "$FN/direct-mashup" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{
    "parent_a": {"type": "mashup", "id": "<mashup_id from above>"},
    "parent_b": {"type": "track", "id": "dracula-tame-impala"},
    "physics": {"velocity_deg_s": 200, "tilt": 0, "contact_angle": 1},
    "device_name": "Pixel Fold"
  }'
```

How to read the params on the device:

- `base_track` is the bed and `overlay` is the other parent. `overlay_pitch_semitones` applies to the overlay.
- `tempo_follows` sets the tempo. The other track plays at rate `stretch_ratio` (= `target_bpm / its BPM`), so the tempo track plays at 1.0.
- `stretch_ratio` is clamped to 0.92–1.08. When it had to be clamped, `warnings` says so and gives the BPM the other track will actually reach.
- `target_bpm`, `stretch_ratio`, and the mashup's `key_name`/`camelot`/`energy` are computed by the server, never by the model. The key is the base track's key, and energy is the mean of the parents' energy. They're stored in `params` so the mashup can later be a parent itself.
- `warnings` also reports when the fallback was used and when the keys still clash after the pitch shift.

When OpenAI errors, takes longer than 8 s, refuses, or returns JSON that doesn't fit the schema, the params are computed locally (`params_source: "fallback"`, title `Untitled Collision`). Let `t = clamp((velocity - 120) / 230, 0, 1)` (0 for a slow close, 1 for a hard slam). Each value interpolates linearly from its slow end to its fast end:

| param | slow close (t=0) | hard slam (t=1) |
|---|---|---|
| aggression | 0.2 | 0.9 |
| base_gain | 0.8 | 1.0 |
| overlay_gain | 0.6 | 0.95 |
| lowpass_hz | 150 | 300 |
| highpass_hz | 350 | 200 |
| reverb_wet | 35 | 5 |

`base_track`: tilt < -0.2 → a, tilt > 0.2 → b, otherwise the higher-energy parent. `tempo_follows` = base. The pitch shift is the smallest shift within ±2 semitones that moves the overlay closest to the base on the Camelot wheel.

Cover art generation starts in the background (`EdgeRuntime.waitUntil`), so the response doesn't wait for it. `art_url` is filled in a few seconds later and arrives through the realtime feed.

### `POST /generate-art`

Retries or regenerates cover art. Existing art is returned unchanged unless `force` is true.

```sh
curl -s "$FN/generate-art" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mashup_id": "<mashup_id>"}'

curl -s "$FN/generate-art" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mashup_id": "<mashup_id>", "force": true}'
# {"mashup_id": "...", "art_url": "http://.../storage/v1/object/public/covers/<id>.png?v=...", "generated": true}
```

The image is stored at `covers/<mashup_id>.png`. `art_url` carries a `?v=` version so clients don't show a cached old image after a retry.

### Lineage: `get_lineage(mashup_id uuid)`

A SQL function callable through PostgREST. It returns every ancestor edge, breadth first. Each ancestor mashup is expanded once, so shared ancestors don't repeat.

```sh
curl -s "$API_URL/rest/v1/rpc/get_lineage" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mashup_id": "<mashup_id>"}'
# [{"depth":1,"child_id":"<mashup_id>","slot":"a","ancestor_type":"mashup","ancestor_id":"...","title":"..."},
#  {"depth":1,"child_id":"<mashup_id>","slot":"b","ancestor_type":"track","ancestor_id":"dracula-tame-impala","title":"Dracula"}, ...]
```

### Realtime feed

`mashups` is in the `supabase_realtime` publication, and anon can read it. Subscribe to `INSERT` for new mashups and `UPDATE` for `art_url` arriving:

```swift
let channel = supabase.channel("feed")
let changes = channel.postgresChange(AnyAction.self, schema: "public", table: "mashups")
await channel.subscribe()
for await change in changes { /* .insert / .update */ }
```

For the feed's initial page, read the table directly: `GET $API_URL/rest/v1/mashups?order=created_at.desc&limit=50`.

## Security model

- RLS is on for every table. `anon` and `authenticated` can `SELECT` everything, and all writes are revoked from them. Only the Edge Functions (service role) insert or update.
- `covers` is a public bucket (PNG only, 10 MB max), and only the service role uploads to it.
- The OpenAI key and model names are read only from secrets. Upstream error details go to function logs, not to clients.
- Anyone holding the anon key can call `generate-art`, which costs OpenAI credits. It skips regeneration when art already exists, so repeat calls are cheap, but `force: true` always regenerates.
# slam_bitrig_hackthon
