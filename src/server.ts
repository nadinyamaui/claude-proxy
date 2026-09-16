import { createServer, type Server } from "node:http";
import { config } from "./config.js";
import { authorize, BodyError, json, readJsonBody } from "./http.js";
import { ProviderError, providers, run } from "./providers/index.js";
import { parseRunBody } from "./request.js";
import { createRunsService, handleRuns, type RunsService } from "./runs/routes.js";

export type App = {
  server: Server;
  runs: RunsService;
  /** Stops in-flight background runs and closes the database. */
  shutdown: () => Promise<void>;
};

export function createApp(runs: RunsService = createRunsService()): App {
  const server = createServer((httpReq, res) => {
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

      try {
        if (url.pathname.startsWith("/runs")) {
          if (!(await handleRuns(runs, httpReq, res, url))) json(res, 404, { error: "not found" });
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

        const { provider, req } = parseRunBody(await readJsonBody(httpReq));
        json(res, 200, await run(provider, req));
      } catch (err) {
        if (err instanceof BodyError) {
          // An oversized body leaves unread bytes in flight; close the
          // connection once the client has the response.
          const close = err.status === 413 ? () => httpReq.destroy() : undefined;
          res.setHeader("connection", "close");
          json(res, err.status, { error: err.message }, close);
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

  return { server, runs, shutdown: () => runs.shutdown() };
}

export function start(): App {
  const app = createApp();
  const orphans = app.runs.store.recoverOrphans();
  if (orphans > 0) console.log(`marked ${orphans} run(s) from a previous process as failed`);
  app.server.listen(config.port, config.host, () => {
    console.log(
      `proxy listening on http://${config.host}:${config.port} (token required); runs in ${config.runsDir}`,
    );
  });
  return app;
}
