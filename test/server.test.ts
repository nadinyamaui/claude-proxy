import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

const TOKEN = "test-token";
let base: string;
const app = createApp();
const { server } = app;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await app.shutdown();
});

/** `Response.json()` is `unknown`; every assertion here checks the shape itself. */
async function jsonBody<T = Record<string, string>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function run(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("GET /health", () => {
  it("is open and lists the providers", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      providers: ["claude", "codex", "grok"],
    });
  });
});

describe("auth", () => {
  it("rejects a missing token", async () => {
    expect((await run({ prompt: "hi" }, null)).status).toBe(401);
  });

  it("rejects a wrong token of the same length", async () => {
    expect((await run({ prompt: "hi" }, "test-tokeX")).status).toBe(401);
  });

  it("rejects a token that is merely a prefix", async () => {
    expect((await run({ prompt: "hi" }, "test")).status).toBe(401);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("405s a GET on /run and advertises POST", async () => {
    const res = await fetch(`${base}/run`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("validation", () => {
  it("rejects a missing prompt", async () => {
    const res = await run({});
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatch(/prompt is required/);
  });

  it("rejects an empty prompt", async () => {
    expect((await run({ prompt: "" })).status).toBe(400);
  });

  it("rejects a non-string prompt", async () => {
    expect((await run({ prompt: 42 })).status).toBe(400);
  });

  it("rejects an unknown provider and names the valid ones", async () => {
    const res = await run({ prompt: "hi", provider: "gemini" });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatch(/claude, codex, grok/);
  });

  it("rejects a baseUrl that is not an http(s) URL", async () => {
    const responses = await Promise.all(
      ["not a url", "file:///etc/passwd", 42].map((baseUrl) => run({ prompt: "hi", baseUrl })),
    );
    for (const res of responses) expect(res.status).toBe(400);
    const bodies = await Promise.all(responses.map((res) => jsonBody(res)));
    for (const body of bodies) expect(body.error).toMatch(/baseUrl must be an http or https URL/);
  });

  it("rejects a non-string apiKey", async () => {
    const res = await run({ prompt: "hi", apiKey: 42 });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatch(/apiKey must be a string/);
  });

  it("rejects a body that is not an object", async () => {
    expect((await run("just a string")).status).toBe(400);
  });

  it("rejects malformed json", async () => {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body over the cap with 413, not a dropped connection", async () => {
    const res = await run({ prompt: "x".repeat(2000) });
    expect(res.status).toBe(413);
    expect((await jsonBody(res)).error).toMatch(/exceeds 1024 bytes/);
  });
});

describe("POST /run against a stub CLI", () => {
  it("returns a normalized result", async () => {
    const res = await run({ prompt: "hello" });
    expect(res.status).toBe(200);

    const body = await jsonBody(res);
    expect(body).toMatchObject({
      provider: "claude",
      text: "echo: hello",
      sessionId: "fake-session-1",
      costUsd: 0.42,
    });
  });

  it("defaults to claude when no provider is given", async () => {
    expect((await jsonBody(await run({ prompt: "hi" }))).provider).toBe("claude");
  });

  it("forwards resume and model as flags", async () => {
    const res = await run({ prompt: "hi", sessionId: "s1", model: "m1" });
    const body = await jsonBody<{ raw: { argv: string[] } }>(res);
    expect(body.raw.argv).toEqual(expect.arrayContaining(["--resume", "s1", "--model", "m1"]));
  });

  it("hands apiKey and baseUrl to the CLI as environment variables", async () => {
    const res = await run({ prompt: "CREDS", apiKey: "sk-test", baseUrl: "https://gw.example/v1" });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ text: string; raw: { argv: string[] } }>(res);
    expect(body.text).toBe("key: tset-ks url: https://gw.example/v1");
    // Never on the command line, where other local users could read it.
    expect(JSON.stringify(body.raw.argv)).not.toContain("sk-test");
    // Scoped to that one child, not leaked into the proxy for later requests.
    expect(process.env["ANTHROPIC_API_KEY"]).not.toBe("sk-test");
  });

  it("reports a CLI failure as 502 with its stderr", async () => {
    const res = await run({ prompt: "FAIL" });
    expect(res.status).toBe(502);

    const body = await jsonBody(res);
    expect(body).toMatchObject({ provider: "claude", exitCode: 3 });
    expect(body.detail).toMatch(/asked to fail/);
  });

  it("returns structured Claude failure feedback with a 502 response", async () => {
    const res = await run({ prompt: "RATE_LIMIT" });

    expect(res.status).toBe(502);
    expect((await jsonBody(res)).error).toBe("You've hit your session limit · resets 11:10am (UTC)");
  });

  it("reports unparseable CLI output as 502", async () => {
    const res = await run({ prompt: "NOTJSON" });
    expect(res.status).toBe(502);
    expect((await jsonBody(res)).error).toMatch(/could not parse/);
  });
});
