// POST /generate-art {mashup_id, force?} — (re)generate a mashup's cover art.
// Existing art is returned as-is unless force is true.

import { generateArt } from "../_shared/art.ts";
import { HttpError, json, readJsonBody, serve } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { validateGenerateArtInput } from "../_shared/validate.ts";

serve(["POST"], async (req) => {
  const input = validateGenerateArtInput(await readJsonBody(req));
  if (!input.ok) throw new HttpError(400, "Invalid request body", input.errors);
  const { mashup_id, force } = input.value;

  try {
    const result = await generateArt(serviceClient(), mashup_id, { force });
    return json({ mashup_id, ...result });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`Cover art for ${mashup_id} failed:`, err);
    throw new HttpError(502, "Cover art generation failed; check the generate-art function logs");
  }
});
