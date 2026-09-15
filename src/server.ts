import { createServer, type Server } from "node:http";
import { config } from "./config.js";
import { authorize, BodyError, json, readJsonBody } from "./http.js";
import {
  isProviderName,
  ProviderError,
  providers,
  run,
  type ProviderName,
  type RunRequest,
} from "./providers/index.js";

type RunBody = {
  provider?: unknown;
  prompt?: unknown;
  sessionId?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Validates a POST /run body into a provider request, or throws BodyError. */
function parseRunBody(body: unknown): { provider: ProviderName; req: RunRequest } {
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

export function createApp(): Server {
  return createServer((httpReq, res) => {
    const url = new URL(httpReq.url ?? "/", `http://${httpReq.headers.host ?? "localhost"}`);

    void (async () => {
      if (url.pathname === "/health") {
        json(res, 200, { ok: true, providers: Object.keys(providers) });
        return;
      }

      if (!authorize(httpReq)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (url.pathname !== "/run") {
        json(res, 404, { error: "not found" });
        return;
      }
      if (httpReq.method !== "POST") {
        res.setHeader("allow", "POST");
        json(res, 405, { error: "method not allowed" });
        return;
      }

      try {
        const { provider, req } = parseRunBody(await readJsonBody(httpReq));
        json(res, 200, await run(provider, req));
      } catch (err) {
        if (err instanceof BodyError) {
          json(res, 400, { error: err.message });
        } else if (err instanceof ProviderError) {
          json(res, 502, {
            error: err.message,
            provider: err.provider,
            exitCode: err.code,
            detail: err.detail,
          });
        } else {
          console.error(err);
          json(res, 500, { error: "internal error" });
        }
      }
    })();
  });
}

export function start(): Server {
  const server = createApp();
  server.listen(config.port, config.host, () => {
    const auth = config.token ? "token required" : "NO AUTH";
    console.log(`proxy listening on http://${config.host}:${config.port} (${auth})`);
  });
  return server;
}
