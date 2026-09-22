import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { config } from "../config.js";
import { BodyError, json, readMultipart } from "../http.js";
import { parseRunBody, str } from "../request.js";
import { extractZip, ZipError, zipDirectory } from "../zip.js";
import { Runner } from "./runner.js";
import { isRunStatus, RunStore, type RunRecord } from "./store.js";

export type RunsService = {
  store: RunStore;
  runner: Runner;
  shutdown: () => Promise<void>;
};

export function createRunsService(): RunsService {
  mkdirSync(config.runsDir, { recursive: true });
  const store = new RunStore(config.runsDb);
  const runner = new Runner(store, {
    maxConcurrent: config.maxConcurrentRuns,
    timeoutMs: config.runTimeoutMs,
  });
  return {
    store,
    runner,
    async shutdown() {
      await runner.shutdown();
      store.close();
    },
  };
}

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  if (v === null) return undefined;
  if (typeof v !== "string") throw new BodyError(`${name} must be a text field, not a file`);
  return str(v);
}

/** Public view of a run; `raw` is dropped from listings to keep them small. */
function view(run: RunRecord, { full }: { full: boolean }): unknown {
  if (full || !run.result) return run;
  const result: Record<string, unknown> = { ...run.result };
  delete result["raw"];
  return { ...run, result };
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new BodyError(`${name} must be a non-negative integer`);
  return Math.min(n, max);
}

function insideRunsDir(dir: string): boolean {
  const root = resolve(config.runsDir) + sep;
  return resolve(dir).startsWith(root);
}

async function createRun(svc: RunsService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipart(req, config.maxUploadBytes);
  // Arbitrary per-run env could redirect the CLI (e.g. ANTHROPIC_BASE_URL)
  // with the operator's login; only apiKey / baseUrl reach its environment.
  if (form.has("env")) throw new BodyError("env is not supported; use apiKey and baseUrl");
  const {
    provider,
    req: runReq,
    env,
  } = parseRunBody({
    provider: field(form, "provider"),
    prompt: field(form, "prompt"),
    sessionId: field(form, "sessionId"),
    model: field(form, "model"),
    systemPrompt: field(form, "systemPrompt"),
    apiKey: field(form, "apiKey"),
    baseUrl: field(form, "baseUrl"),
  });

  const upload = form.get("zip");
  if (upload !== null && !(upload instanceof File)) throw new BodyError("zip must be a file upload");

  const id = randomUUID();
  const workdir = join(config.runsDir, id);
  mkdirSync(workdir, { recursive: true });

  let extracted: { files: number; bytes: number } | undefined;
  if (upload) {
    try {
      extracted = extractZip(Buffer.from(await upload.arrayBuffer()), workdir, {
        maxBytes: config.maxUnzipBytes,
      });
    } catch (err) {
      rmSync(workdir, { recursive: true, force: true });
      if (err instanceof ZipError) throw new BodyError(`zip: ${err.message}`);
      throw err;
    }
  }

  const input: Parameters<RunStore["create"]>[0] = { id, provider, prompt: runReq.prompt, workdir };
  if (runReq.model) input.model = runReq.model;
  if (runReq.systemPrompt) input.systemPrompt = runReq.systemPrompt;
  if (runReq.sessionId) input.sessionId = runReq.sessionId;
  if (upload) input.zipName = upload.name;

  const run = svc.store.create(input);
  if (extracted) {
    svc.store.appendLog(
      id,
      "proxy",
      `extracted ${upload!.name}: ${extracted.files} files, ${extracted.bytes} bytes`,
    );
  }
  if (Object.keys(env).length > 0) {
    svc.store.appendLog(id, "proxy", `credential env: ${Object.keys(env).join(", ")}`);
  }
  svc.runner.enqueue(id, env);
  json(res, 202, view(svc.store.get(id) ?? run, { full: true }));
}

function getRunOr404(svc: RunsService, id: string, res: ServerResponse): RunRecord | undefined {
  const run = svc.store.get(id);
  if (!run) json(res, 404, { error: "run not found" });
  return run;
}

/**
 * Routes everything under /runs. Returns false when the path is not one of
 * ours so the caller can 404. Throws BodyError for client mistakes.
 */
export async function handleRuns(
  svc: RunsService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (url.pathname === "/runs") {
    if (method === "POST") {
      await createRun(svc, req, res);
      return true;
    }
    if (method === "GET") {
      const status = url.searchParams.get("status");
      if (status !== null && !isRunStatus(status)) throw new BodyError("unknown status");
      const limit = intParam(url, "limit", 50, 500);
      const runs = svc.store.list(status ? { status, limit } : { limit });
      json(res, 200, { runs: runs.map((r) => view(r, { full: false })) });
      return true;
    }
    res.setHeader("allow", "GET, POST");
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  const match = /^\/runs\/([0-9a-f-]{36})(?:\/(logs|workdir\.zip|cancel))?$/.exec(url.pathname);
  if (!match) return false;
  const id = match[1]!;
  const sub = match[2];

  if (sub === undefined) {
    if (method === "GET") {
      const run = getRunOr404(svc, id, res);
      if (run) json(res, 200, view(run, { full: true }));
      return true;
    }
    if (method === "DELETE") {
      const run = getRunOr404(svc, id, res);
      if (!run) return true;
      await svc.runner.cancel(id);
      svc.store.delete(id);
      if (insideRunsDir(run.workdir)) rmSync(run.workdir, { recursive: true, force: true });
      json(res, 200, { deleted: id });
      return true;
    }
    res.setHeader("allow", "GET, DELETE");
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  if (sub === "logs") {
    if (method !== "GET") {
      res.setHeader("allow", "GET");
      json(res, 405, { error: "method not allowed" });
      return true;
    }
    const run = getRunOr404(svc, id, res);
    if (!run) return true;
    const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url, "limit", 1000, 10_000);
    const lines = svc.store.logs(id, { after, limit });
    json(res, 200, {
      id,
      status: run.status,
      lines,
      // Pass back as `after` to page through new lines; poll until `status` is terminal.
      next: lines.length > 0 ? lines[lines.length - 1]!.id : after,
    });
    return true;
  }

  if (sub === "workdir.zip") {
    if (method !== "GET") {
      res.setHeader("allow", "GET");
      json(res, 405, { error: "method not allowed" });
      return true;
    }
    const run = getRunOr404(svc, id, res);
    if (!run) return true;
    if (!existsSync(run.workdir)) {
      json(res, 410, { error: "working directory no longer exists" });
      return true;
    }
    const archive = zipDirectory(run.workdir);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": archive.length,
      "content-disposition": `attachment; filename="${id}.zip"`,
    });
    res.end(archive);
    return true;
  }

  // sub === "cancel"
  if (method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const run = getRunOr404(svc, id, res);
  if (!run) return true;
  if (run.status !== "queued" && run.status !== "running") {
    json(res, 409, { error: `run is already ${run.status}` });
    return true;
  }
  await svc.runner.cancel(id);
  json(res, 200, view(svc.store.get(id) ?? run, { full: true }));
  return true;
}
