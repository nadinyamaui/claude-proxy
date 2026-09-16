import { BodyError } from "./http.js";
import { isProviderName, providers, type ProviderName, type RunRequest } from "./providers/index.js";

type RunBody = {
  provider?: unknown;
  prompt?: unknown;
  sessionId?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
};

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Validates a run body (JSON or form fields) into a provider request, or throws BodyError. */
export function parseRunBody(body: unknown): { provider: ProviderName; req: RunRequest } {
  if (typeof body !== "object" || body === null) throw new BodyError("body must be a JSON object");
  const b = body as RunBody;

  const provider = b.provider ?? "claude";
  if (!isProviderName(provider)) {
    throw new BodyError(`unknown provider; expected one of ${Object.keys(providers).join(", ")}`);
  }

  const prompt = str(b.prompt);
  if (!prompt) throw new BodyError("prompt is required and must be a non-empty string");

  const req: RunRequest = { prompt };
  const sessionId = str(b.sessionId);
  const model = str(b.model);
  const systemPrompt = str(b.systemPrompt);
  if (sessionId) req.sessionId = sessionId;
  if (model) req.model = model;
  if (systemPrompt) req.systemPrompt = systemPrompt;

  return { provider, req };
}
