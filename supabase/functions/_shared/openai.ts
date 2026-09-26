// Minimal OpenAI REST client. Keys and model names come only from environment secrets.

import { decodeBase64 } from "jsr:@std/encoding@1/base64";

const OPENAI_API = "https://api.openai.com/v1";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment secret ${name}`);
  return value;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
    "Content-Type": "application/json",
  };
}

async function errorText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 500);
}

export interface JsonSchemaChatRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
}

/**
 * Chat Completions with structured outputs (json_schema, strict). Resolves to the
 * parsed JSON object; throws on HTTP errors, timeouts, refusals, or invalid JSON.
 */
export async function chatJsonSchema(req: JsonSchemaChatRequest): Promise<unknown> {
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(req.timeoutMs),
    body: JSON.stringify({
      model: requireEnv("OPENAI_MODEL"),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI chat completions returned ${res.status}: ${await errorText(res)}`);

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI refused: ${message.refusal}`);
  if (typeof message?.content !== "string") throw new Error("OpenAI response had no message content");
  return JSON.parse(message.content);
}

/** Generate a 1024x1024 PNG with the Images API and return its bytes. */
export async function generateImagePng(prompt: string, timeoutMs: number): Promise<Uint8Array> {
  const model = requireEnv("OPENAI_IMAGE_MODEL");
  const body: Record<string, unknown> = { model, prompt, size: "1024x1024", n: 1 };
  // DALL·E models return URLs unless asked for base64; GPT image models always
  // return base64 and take output_format instead.
  if (model.startsWith("dall-e")) body.response_format = "b64_json";
  else body.output_format = "png";

  const res = await fetch(`${OPENAI_API}/images/generations`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI images returned ${res.status}: ${await errorText(res)}`);

  const image = (await res.json())?.data?.[0];
  if (typeof image?.b64_json === "string") return decodeBase64(image.b64_json);
  if (typeof image?.url === "string") {
    const download = await fetch(image.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!download.ok) throw new Error(`Downloading generated image failed with ${download.status}`);
    return new Uint8Array(await download.arrayBuffer());
  }
  throw new Error("OpenAI images response contained no image");
}
