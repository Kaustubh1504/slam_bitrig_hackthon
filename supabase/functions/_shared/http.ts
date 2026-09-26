// HTTP plumbing shared by every function: CORS, JSON responses, error mapping.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** An error with an HTTP status that is safe to show to the client. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") throw new HttpError(400, "Request body must be a JSON object");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

/**
 * Deno.serve wrapper: answers CORS preflight, rejects other methods with 405,
 * and turns thrown errors into JSON responses (HttpError -> its status, anything else -> 500).
 */
export function serve(methods: string[], handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!methods.includes(req.method)) {
      return json(
        { error: `Method ${req.method} not allowed; use ${methods.join(" or ")}` },
        405,
        { Allow: [...methods, "OPTIONS"].join(", ") },
      );
    }

    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(
          err.details === undefined ? { error: err.message } : { error: err.message, details: err.details },
          err.status,
        );
      }
      console.error("Unhandled error:", err);
      return json({ error: "Internal server error" }, 500);
    }
  });
}
