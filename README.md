# claude-proxy

[![CI](https://github.com/nadinyamaui/claude-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/nadinyamaui/claude-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A small HTTP proxy in front of local coding-agent CLIs. One JSON shape, three
backends: **claude**, **codex** and **grok**.

`POST /run` spawns the provider's CLI in non-interactive mode, feeds it the
prompt, and returns the normalized answer. `POST /runs` does the same in the
background: upload a zip, it becomes the agent's working directory, and the
run's status, streamed logs and resulting files are available from the API
while it works. No dependencies — Node's built-in `http`, `node:sqlite` and
TypeScript.

## Setup

```bash
npm install
cp .env.example .env
```

Each provider must be installed and signed in separately (`claude`, `codex
login`, `grok login`). Override binary paths with `CLAUDE_BIN`, `CODEX_BIN`,
`GROK_BIN`.

## Run

```bash
npm run dev
```

`npm run build && npm start` for the compiled version.

## Development

```bash
npm run check
```

Runs `format:check`, `lint`, `typecheck` and `test` — the same four things CI
runs. `npm run format` and `npm run lint:fix` apply automatic fixes.

Linting is [oxlint](https://oxc.rs), not ESLint. The project is on TypeScript
7, and no typescript-eslint release supports the TS 7 compiler API yet
([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940));
oxlint parses TypeScript natively, so it does not care. The tradeoff is that
type-aware rules such as `no-floating-promises` are not available — `tsc` in
`strict` mode plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` is doing that work instead.

The test suite drives a stub CLI in `test/fixtures/`, so it runs offline and
costs nothing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## API

### `GET /health`

Unauthenticated. Returns `{ "ok": true, "providers": [...] }`.

### `POST /run`

```jsonc
{
  "prompt": "Explain this repo", // required
  "provider": "claude", // claude | codex | grok, default claude
  "sessionId": "…", // resume a prior turn
  "model": "…", // provider-specific model id
  "systemPrompt": "…", // extra instructions
}
```

Responds with:

```jsonc
{
  "provider": "claude",
  "text": "…", // the final answer
  "sessionId": "…", // pass back in to continue the conversation
  "costUsd": 0.068, // when the provider reports it
  "raw": {}, // the provider's untouched output
}
```

Errors: `400` malformed request, `401` bad token, `413` body over
`MAX_BODY_BYTES`, `502` the CLI failed (body carries `exitCode` and the CLI's
stderr in `detail`), `500` otherwise.

```bash
curl -s localhost:8787/run \
  -H 'authorization: Bearer $PROXY_TOKEN' \
  -d '{"provider":"claude","prompt":"Reply with exactly: PONG"}'
```

### Background runs: `POST /runs`

For long agent sessions that need their own files. The body is
`multipart/form-data`:

| field          | required | notes                                                              |
| -------------- | -------- | ------------------------------------------------------------------ |
| `prompt`       | yes      |                                                                    |
| `zip`          | no       | Unpacked into a fresh directory that becomes the CLI's cwd         |
| `provider`     | no       | `claude` (default), `codex`, `grok`                                |
| `model`        | no       | provider-specific model id                                         |
| `systemPrompt` | no       | extra instructions                                                 |
| `sessionId`    | no       | resume a prior session                                             |
| `env`          | no       | JSON object of extra environment variables for this run's CLI only |

```bash
curl -s localhost:8787/runs \
  -F prompt="Build the site described in PRODUCT.md" \
  -F zip=@website-build-69.zip \
  -F env='{"WEBSITE_BUILD_MCP_TOKEN":"…"}'
```

Responds `202` with the run record and returns immediately. The zip is
validated and extracted before responding, so a bad archive is a `400`, not a
failed run. Zips are read by a built-in parser: stored and deflated entries,
no zip64 or encryption, and entries with absolute paths, `..` or symlinks are
rejected. Anything the zip carries that the CLI reads from its cwd —
`.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.agents/skills/` — takes effect.

A run record looks like:

```jsonc
{
  "id": "6f1c…", // UUID
  "status": "running", // queued | running | succeeded | failed | cancelled
  "provider": "claude",
  "prompt": "…",
  "model": null,
  "systemPrompt": null,
  "sessionId": null, // the session that was resumed, if any
  "zipName": "website-build-69.zip",
  "workdir": "/…/runs/6f1c…",
  "createdAt": "2026-09-15T17:00:00.000Z",
  "startedAt": "…",
  "finishedAt": null,
  "exitCode": null,
  "error": null, // set when failed or cancelled
  "result": null, // same shape as POST /run's response once succeeded
}
```

Runs execute `MAX_CONCURRENT_RUNS` at a time (default 2) and are killed after
`RUN_TIMEOUT_MS` (default one hour). Claude runs use `--output-format
stream-json --verbose` so every event lands in the log as it happens; codex
already streams JSONL; grok has no streaming mode, so its log is the final
output. If the proxy restarts, runs that were queued or running are marked
`failed` at startup.

| endpoint                           | what it does                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /runs?status=&limit=`         | Newest first, default 50, max 500. `result.raw` is omitted from listings.                                                                                               |
| `GET /runs/:id`                    | Full record, including `result.raw`.                                                                                                                                    |
| `GET /runs/:id/logs?after=&limit=` | Log lines `{ id, ts, stream, line }` with `stream` in `stdout`, `stderr`, `proxy`. Returns `next`; pass it back as `after` to page, and stop when `status` is terminal. |
| `GET /runs/:id/workdir.zip`        | The working directory as it is now, including files the agent wrote. `410` if it was deleted.                                                                           |
| `POST /runs/:id/cancel`            | SIGTERM, then SIGKILL after five seconds. `409` if already finished.                                                                                                    |
| `DELETE /runs/:id`                 | Cancels if needed, then removes the record, its logs and the directory.                                                                                                 |

Polling loop in one line:

```bash
curl -s "localhost:8787/runs/$ID/logs?after=$NEXT" | jq -r '.lines[].line'
```

The runs API sits behind the same `PROXY_TOKEN` gate as `/run` and is meant
for a private port: whoever can reach it can run an agent with real tool
access inside any directory they upload, and download whatever it produced.

## Security

- Prompts are passed as argv values or over stdin to a directly-spawned
  process. No shell is involved, so prompts cannot be injected as commands.
- `PROXY_TOKEN` gates `/run` with a constant-time comparison. **Auth is off
  when it is unset** — the server binds to `127.0.0.1` by default for that
  reason. Set both before exposing it anywhere.
- Request bodies are capped (`MAX_BODY_BYTES`) and each run is killed after
  `TIMEOUT_MS`.
- The CLIs run with this process's full environment and real tool access,
  inside `WORKDIR` (or, for background runs, the uploaded directory). Anyone
  who can reach `/run` or `/runs` can act as those agents.
- Uploaded zips are unpacked by a built-in reader that refuses path traversal,
  symlinks and archives expanding past `MAX_UNZIP_BYTES`. Per-run `env` values
  are passed to the CLI but never stored.

See [SECURITY.md](SECURITY.md) for the full threat model and how to report a
vulnerability.

## CI

Checks run on GitHub-hosted `ubuntu-latest` runners, free for public
repositories:

| Workflow                | What it does                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `ci.yml`                | format, lint, typecheck, build, test, then boots `dist/index.js` and hits `/health`; plus `npm audit` |
| `codeql.yml`            | CodeQL `security-and-quality` on push, PR, and weekly                                                 |
| `dependency-review.yml` | blocks PRs introducing high-severity advisories                                                       |
| `dependabot.yml`        | weekly npm and Actions updates, dev-tooling bumps grouped                                             |

`ci.yml` runs on Node 22 and 24 to cover the `engines.node: >=22.13` claim in
`package.json` (the runs store uses `node:sqlite`, unflagged from 22.13);
formatting and linting run once, on 24.

Hardening worth keeping if you add workflows: the default `GITHUB_TOKEN` is
read-only, and nothing uses `pull_request_target` — which would run workflow
code from a fork with repository secrets in scope. Fork PRs are safe on hosted
runners precisely because they get a disposable VM and no secrets.

## Provider notes

The three CLIs differ, and `src/providers/` isolates the differences:

|               | claude                    | codex                   | grok                               |
| ------------- | ------------------------- | ----------------------- | ---------------------------------- |
| invocation    | `-p --output-format json` | `exec --json -`         | `-p <prompt> --output-format json` |
| prompt via    | stdin                     | stdin                   | argv                               |
| resume        | `--resume <id>`           | `exec resume <id>`      | `--resume <id>`                    |
| system prompt | `--append-system-prompt`  | prepended to the prompt | `--system-prompt-override`         |
| output        | one JSON object           | JSONL event stream      | one JSON object                    |

Verified end-to-end against a signed-in `claude`. Codex's spawn, streaming and
error path were verified, but its success payload was not (not authenticated
here); grok's JSON success shape is likewise unverified, so its parser accepts
both claude-style and plain field names and falls back to raw text. Adjust
`parse` in the relevant file if a field comes back empty.

Adding a provider means adding one file to `src/providers/` implementing the
`Provider` type, then listing it in `src/providers/index.ts`.

## License

[MIT](LICENSE) © Nadin Yamaui
