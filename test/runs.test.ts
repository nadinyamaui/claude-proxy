import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { readEntries, zipDirectory } from "../src/zip.js";

const TOKEN = "test-token";
let base: string;
const app = createApp();

beforeAll(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.shutdown();
  await new Promise<void>((resolve, reject) => app.server.close((err) => (err ? reject(err) : resolve())));
});

type Run = {
  id: string;
  status: string;
  provider: string;
  workdir: string;
  zipName: string | null;
  exitCode: number | null;
  error: string | null;
  result: {
    text: string;
    sessionId?: string;
    costUsd?: number;
    raw?: { argv: string[]; cwd: string };
  } | null;
};
type Logs = { status: string; lines: { id: number; stream: string; line: string }[]; next: number };

const headers = { authorization: `Bearer ${TOKEN}` };

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

function sampleZip(files: Record<string, string>): Blob {
  const dir = mkdtempSync(join(tmpdir(), "runs-test-src-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...name.split("/")), content);
  }
  return new Blob([new Uint8Array(zipDirectory(dir))], { type: "application/zip" });
}

function form(fields: Record<string, string>, zip?: Blob): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (zip) fd.append("zip", zip, "upload.zip");
  return fd;
}

async function createRun(fields: Record<string, string>, zip?: Blob): Promise<Run> {
  const res = await api("/runs", { method: "POST", body: form(fields, zip) });
  expect(res.status).toBe(202);
  return (await res.json()) as Run;
}

/** Polls `fetch` until `done` accepts the value. Sequential by nature. */
async function poll<T>(
  fetchOnce: () => Promise<T>,
  done: (v: T) => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const value = await fetchOnce();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function getRun(id: string): Promise<Run> {
  return (await (await api(`/runs/${id}`)).json()) as Run;
}

async function getLogs(id: string, query = ""): Promise<Logs> {
  return (await (await api(`/runs/${id}/logs${query}`)).json()) as Logs;
}

function waitFor(id: string, done: (r: Run) => boolean): Promise<Run> {
  return poll(() => getRun(id), done, `run ${id} reaching the wanted state`);
}

const terminal = (r: Run) => !["queued", "running"].includes(r.status);

describe("POST /runs", () => {
  it("unzips the upload, runs the CLI inside it, and stores the result and logs", async () => {
    const created = await createRun(
      { prompt: "WRITE" },
      sampleZip({ "PROMPT.md": "brief", "sub/data.json": "{}" }),
    );
    // The queue may already have picked the run up by the time we respond.
    expect(["queued", "running"]).toContain(created.status);
    expect(created).toMatchObject({ provider: "claude", zipName: "upload.zip" });
    expect(created.workdir.startsWith(config.runsDir)).toBe(true);
    expect(readFileSync(join(created.workdir, "sub", "data.json"), "utf8")).toBe("{}");

    const run = await waitFor(created.id, terminal);
    expect(run.status).toBe("succeeded");
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({ text: "echo: WRITE", sessionId: "fake-session-1", costUsd: 0.42 });
    expect(run.result?.raw?.cwd).toBe(created.workdir);
    expect(run.result?.raw?.argv).toEqual(
      expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ]),
    );
    expect(readFileSync(join(created.workdir, "written-by-fake-claude.txt"), "utf8")).toMatch(
      /hello from the agent/,
    );

    const logs = await getLogs(created.id);
    expect(logs.status).toBe("succeeded");
    const byStream = (s: string) => logs.lines.filter((l) => l.stream === s).map((l) => l.line);
    expect(byStream("proxy")[0]).toMatch(/extracted upload\.zip: 2 files/);
    expect(byStream("proxy")).toContainEqual(expect.stringMatching(/starting claude in/));
    expect(byStream("stderr")).toEqual(["fake-claude: streaming"]);
    expect(byStream("stdout")).toHaveLength(3);
    expect(JSON.parse(byStream("stdout")[2]!)).toMatchObject({ type: "result" });
    expect(logs.next).toBe(logs.lines.at(-1)?.id);
  });

  it("works without a zip, in an empty working directory", async () => {
    const created = await createRun({ prompt: "hi" });
    expect(created.zipName).toBeNull();
    expect(existsSync(created.workdir)).toBe(true);
    expect((await waitFor(created.id, terminal)).result?.text).toBe("echo: hi");
  });

  it("passes per-run env to the CLI without storing it", async () => {
    const created = await createRun({ prompt: "ENV", env: JSON.stringify({ FAKE_ENV: "s3cret" }) });
    const run = await waitFor(created.id, terminal);
    // The fixture echoes the value reversed, so the secret itself must not
    // appear anywhere in what the proxy stored.
    expect(run.result?.text).toBe("env: terc3s");
    expect(JSON.stringify(run)).not.toContain("s3cret");
    const logs = await getLogs(created.id);
    expect(logs.lines.map((l) => l.line)).toContainEqual("env overrides: FAKE_ENV");
    expect(JSON.stringify(logs)).not.toContain("s3cret");
  });

  it("forwards provider flags", async () => {
    const created = await createRun({ prompt: "hi", model: "m9", sessionId: "s9", systemPrompt: "terse" });
    const run = await waitFor(created.id, terminal);
    expect(run.result?.raw?.argv).toEqual(
      expect.arrayContaining(["--resume", "s9", "--model", "m9", "--append-system-prompt", "terse"]),
    );
  });

  it("records a failed CLI with its exit code and stderr in the logs", async () => {
    const created = await createRun({ prompt: "FAIL" });
    const run = await waitFor(created.id, terminal);
    expect(run).toMatchObject({ status: "failed", exitCode: 3, result: null });
    expect(run.error).toMatch(/exited with code 3/);
    const logs = await getLogs(created.id);
    expect(logs.lines.some((l) => l.stream === "stderr" && /asked to fail/.test(l.line))).toBe(true);
  });

  it("returns structured Claude failure feedback instead of the process exit", async () => {
    const created = await createRun({ prompt: "RATE_LIMIT" });

    const run = await waitFor(created.id, terminal);

    expect(run).toMatchObject({
      status: "failed",
      exitCode: 1,
      error: "You've hit your session limit · resets 11:10am (UTC)",
      result: null,
    });
  });

  it("rejects bad input with 400", async () => {
    const bad = async (fields: Record<string, string>, zip?: Blob) =>
      (await api("/runs", { method: "POST", body: form(fields, zip) })).json() as Promise<{ error: string }>;
    expect((await bad({})).error).toMatch(/prompt is required/);
    expect((await bad({ prompt: "x", provider: "gemini" })).error).toMatch(/unknown provider/);
    expect((await bad({ prompt: "x", env: "nope" })).error).toMatch(/env must be a JSON object/);
    expect((await bad({ prompt: "x", env: '{"BAD KEY":"v"}' })).error).toMatch(/not a valid variable name/);
    expect((await bad({ prompt: "x", env: '{"K":1}' })).error).toMatch(/must be a string/);
    expect((await bad({ prompt: "x" }, new Blob(["not a zip"]))).error).toMatch(/^zip: /);
  });

  it("rejects a zip that expands past MAX_UNZIP_BYTES", async () => {
    const res = await api("/runs", {
      method: "POST",
      body: form({ prompt: "x" }, sampleZip({ "big.txt": "a".repeat(150_000) })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/expands to more than/);
  });

  it("rejects an upload over MAX_UPLOAD_BYTES with 413", async () => {
    const fd = new FormData();
    fd.append("prompt", "x");
    fd.append("zip", new Blob([new Uint8Array(250_000)]), "big.zip");
    const res = await api("/runs", { method: "POST", body: fd });
    expect(res.status).toBe(413);
  });

  it("requires multipart", async () => {
    const res = await api("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(415);
  });

  it("is gated by the same token as /run", async () => {
    const res = await fetch(`${base}/runs`, { method: "POST", body: form({ prompt: "x" }) });
    expect(res.status).toBe(401);
  });
});

describe("GET /runs", () => {
  it("lists newest first, filters by status, and omits raw output", async () => {
    const a = await createRun({ prompt: "one" });
    await waitFor(a.id, terminal);
    const b = await createRun({ prompt: "FAIL" });
    await waitFor(b.id, terminal);

    const all = (await (await api("/runs")).json()) as { runs: Run[] };
    const ids = all.runs.map((r) => r.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(all.runs.find((r) => r.id === a.id)?.result).not.toHaveProperty("raw");

    const failed = (await (await api("/runs?status=failed")).json()) as { runs: Run[] };
    expect(failed.runs.every((r) => r.status === "failed")).toBe(true);
    expect(failed.runs.map((r) => r.id)).toContain(b.id);

    expect((await api("/runs?status=bogus")).status).toBe(400);
    expect((await api("/runs?limit=-1")).status).toBe(400);
  });
});

describe("GET /runs/:id/logs", () => {
  it("pages with after= and 404s an unknown run", async () => {
    const created = await createRun({ prompt: "hi" });
    await waitFor(created.id, terminal);
    const first = await getLogs(created.id, "?limit=2");
    expect(first.lines).toHaveLength(2);
    const rest = await getLogs(created.id, `?after=${first.next}`);
    expect(rest.lines[0]?.id).toBeGreaterThan(first.next);
    const again = await getLogs(created.id, `?after=${rest.next}`);
    expect(again.lines).toEqual([]);
    expect(again.next).toBe(rest.next);

    expect((await api(`/runs/00000000-0000-4000-8000-000000000000/logs`)).status).toBe(404);
    expect((await api(`/runs/not-a-uuid/logs`)).status).toBe(404);
  });
});

describe("GET /runs/:id/workdir.zip", () => {
  it("returns the working directory including files the agent produced", async () => {
    const created = await createRun({ prompt: "WRITE" }, sampleZip({ "input.txt": "in" }));
    await waitFor(created.id, terminal);
    const res = await api(`/runs/${created.id}/workdir.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`${created.id}.zip`);
    const names = readEntries(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
    expect(names).toEqual(["input.txt", "written-by-fake-claude.txt"]);
  });
});

describe("cancel and delete", () => {
  it("cancels a running run, terminating the CLI", async () => {
    const created = await createRun({ prompt: "HANG" });
    await waitFor(created.id, (r) => r.status === "running");
    // Wait until the fixture has printed its first line so we know it is up.
    await poll(
      () => getLogs(created.id),
      (l) => l.lines.some((x) => x.stream === "stdout"),
      "fixture start",
    );

    const res = await api(`/runs/${created.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const run = (await res.json()) as Run;
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/cancelled/);

    expect((await api(`/runs/${created.id}/cancel`, { method: "POST" })).status).toBe(409);
  });

  it("cancels a queued run without ever starting it", async () => {
    // MAX_CONCURRENT_RUNS=1 in the suite, so a hanging run blocks the queue.
    const blocker = await createRun({ prompt: "HANG" });
    await waitFor(blocker.id, (r) => r.status === "running");
    const queued = await createRun({ prompt: "hi" });
    expect(queued.status).toBe("queued");

    const res = await api(`/runs/${queued.id}/cancel`, { method: "POST" });
    expect(((await res.json()) as Run).status).toBe("cancelled");
    const logs = await getLogs(queued.id);
    expect(logs.lines.some((l) => /starting claude/.test(l.line))).toBe(false);

    await api(`/runs/${blocker.id}/cancel`, { method: "POST" });
  });

  it("deletes a run, its logs and its working directory", async () => {
    const created = await createRun({ prompt: "hi" }, sampleZip({ "f.txt": "x" }));
    await waitFor(created.id, terminal);
    expect((await api(`/runs/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(created.workdir)).toBe(false);
    expect((await api(`/runs/${created.id}`)).status).toBe(404);
    expect((await api(`/runs/${created.id}/logs`)).status).toBe(404);
    expect((await api(`/runs/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("deleting a running run stops it first", async () => {
    const created = await createRun({ prompt: "HANG" });
    await waitFor(created.id, (r) => r.status === "running");
    expect((await api(`/runs/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(created.workdir)).toBe(false);
    // The queue is free again: a new run gets to execute.
    const next = await createRun({ prompt: "after" });
    expect((await waitFor(next.id, terminal)).status).toBe("succeeded");
  });
});

describe("recovery", () => {
  it("fails runs left in flight by a previous process", () => {
    const { store } = app.runs;
    const dir = join(config.runsDir, "orphan-test");
    mkdirSync(dir, { recursive: true });
    const orphan = store.create({ id: "orphan-1", provider: "claude", prompt: "x", workdir: dir });
    expect(orphan.status).toBe("queued");
    expect(store.recoverOrphans()).toBeGreaterThanOrEqual(1);
    expect(store.get("orphan-1")).toMatchObject({ status: "failed", error: /proxy restarted/ });
    store.delete("orphan-1");
  });
});
