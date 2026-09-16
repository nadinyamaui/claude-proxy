---
name: verify
description: Run this repo's full check suite and smoke-test the proxy end to end. Use before committing, before opening a PR, or when asked whether a change actually works.
---

# Verifying a change

## Static checks and tests

```bash
npm run check
```

This is exactly what CI runs: `format:check`, `lint`, `typecheck`, `test`.
Auto-fixes: `npm run format` and `npm run lint:fix`.

The suite never calls a provider API — `test/fixtures/fake-claude.mjs` stands
in for the real CLI, so it is offline and free. The fixture has magic prompts
for exercising failure paths: `FAIL` (exit 3), `NOTJSON` (unparseable output),
`HANG` (never exits, for timeout tests).

## Smoke-test the running server

`npm run check` does not prove the server actually serves. For any change to
`server.ts`, `http.ts` or `index.ts`, run it:

```bash
npm run build && PORT=8799 PROXY_TOKEN=smoke node dist/index.js
```

Then, in another shell:

```bash
curl -s localhost:8799/health
```

```bash
curl -s -X POST localhost:8799/run -H 'authorization: Bearer smoke' -d '{"prompt":"Reply with exactly: PONG"}'
```

A real run costs money and needs a signed-in CLI. Check `costUsd` in the
response to see what it cost.

## Smoke-test background runs

For changes under `src/runs/`, `src/zip.ts` or the multipart parsing in
`src/http.ts`, exercise the queue with the stub CLI so nothing is billed:

```bash
npm run build && PORT=8799 CLAUDE_BIN=$PWD/test/fixtures/fake-claude.mjs RUNS_DIR=/tmp/proxy-smoke node dist/index.js
```

```bash
cd /tmp && mkdir -p smoke && echo brief > smoke/PRODUCT.md && (cd smoke && zip -qr ../smoke.zip .) && curl -s localhost:8799/runs -F prompt=WRITE -F zip=@/tmp/smoke.zip
```

Then poll `GET /runs/<id>`, read `GET /runs/<id>/logs`, and confirm
`GET /runs/<id>/workdir.zip` contains `written-by-fake-claude.txt`. The
fixture's `HANG` prompt is for checking `POST /runs/<id>/cancel`.

To confirm multi-turn behavior, feed the returned `sessionId` back into a
second request and ask about the first turn.

## What to report

State plainly which of these you actually ran. If you only ran `npm run check`,
say the server was not exercised — do not describe a change as verified
end-to-end on the strength of unit tests alone. If a provider's parser could
not be checked against a signed-in CLI, say that too.
