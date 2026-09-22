import { BodyError } from "./http.js";
import {
  credentialEnv,
  isProviderName,
  providers,
  type Credentials,
  type ProviderName,
  type RunRequest,
} from "./providers/index.js";

type RunBody = {
  provider?: unknown;
  prompt?: unknown;
  sessionId?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
};

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseBaseUrl(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const raw = str(v);
  let url: URL | undefined;
  try {
    if (raw) url = new URL(raw);
  } catch {
    // fall through to the error below
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new BodyError("baseUrl must be an http or https URL");
  }
  return raw;
}

/**
 * Validates a run body (JSON or form fields) into a provider request, or
 * throws BodyError. `env` carries `apiKey` / `baseUrl` as the environment
 * variables the provider's CLI reads; it is kept apart from `req` so the
 * credentials are never stored with a run.
 */
export function parseRunBody(body: unknown): {
  provider: ProviderName;
  req: RunRequest;
  env: Record<string, string>;
} {
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

  if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== "string") {
    throw new BodyError("apiKey must be a string");
  }
  const creds: Credentials = {};
  const apiKey = str(b.apiKey);
  const baseUrl = parseBaseUrl(b.baseUrl);
  // Without its own key, a redirected CLI would send the operator's login to baseUrl.
  if (baseUrl && !apiKey) throw new BodyError("baseUrl requires apiKey");
  if (apiKey) creds.apiKey = apiKey;
  if (baseUrl) creds.baseUrl = baseUrl;

  return { provider, req, env: credentialEnv(provider, creds) };
}
