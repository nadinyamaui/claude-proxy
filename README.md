# claude-proxy

A small HTTP proxy in front of local coding-agent CLIs. One endpoint, one JSON
shape, three backends: **claude**, **codex** and **grok**.

Each request spawns the provider's CLI in non-interactive mode, feeds it the
prompt, and normalizes the answer. No framework dependencies — Node's built-in
`http` plus TypeScript.

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

`npm run build && npm start` for the compiled version. `npm run typecheck` to
check types without emitting.

## API

### `GET /health`

Unauthenticated. Returns `{ "ok": true, "providers": [...] }`.

### `POST /run`

```jsonc
{
  "prompt": "Explain this repo",   // required
  "provider": "claude",            // claude | codex | grok, default claude
  "sessionId": "…",                // resume a prior turn
  "model": "…",                    // provider-specific model id
  "systemPrompt": "…"              // extra instructions
}
```

Responds with:

```jsonc
{
  "provider": "claude",
  "text": "…",          // the final answer
  "sessionId": "…",     // pass back in to continue the conversation
  "costUsd": 0.068,     // when the provider reports it
  "raw": { }            // the provider's untouched output
}
```

Errors: `400` malformed request, `401` bad token, `502` the CLI failed (body
carries `exitCode` and the CLI's stderr in `detail`), `500` otherwise.

```bash
curl -s localhost:8787/run \
  -H 'authorization: Bearer $PROXY_TOKEN' \
  -d '{"provider":"claude","prompt":"Reply with exactly: PONG"}'
```

## Security

- Prompts are passed as argv values or over stdin to a directly-spawned
  process. No shell is involved, so prompts cannot be injected as commands.
- `PROXY_TOKEN` gates `/run` with a constant-time comparison. **Auth is off
  when it is unset** — the server binds to `127.0.0.1` by default for that
  reason. Set both before exposing it anywhere.
- Request bodies are capped (`MAX_BODY_BYTES`) and each run is killed after
  `TIMEOUT_MS`.
- The CLIs run with this process's full environment and real tool access,
  inside `WORKDIR`. Anyone who can reach `/run` can act as those agents.

## Provider notes

The three CLIs differ, and `src/providers/` isolates the differences:

| | claude | codex | grok |
|---|---|---|---|
| invocation | `-p --output-format json` | `exec --json -` | `-p <prompt> --output-format json` |
| prompt via | stdin | stdin | argv |
| resume | `--resume <id>` | `exec resume <id>` | `--resume <id>` |
| system prompt | `--append-system-prompt` | prepended to the prompt | `--system-prompt-override` |
| output | one JSON object | JSONL event stream | one JSON object |

Verified end-to-end against a signed-in `claude`. Codex's spawn, streaming and
error path were verified, but its success payload was not (not authenticated
here); grok's JSON success shape is likewise unverified, so its parser accepts
both claude-style and plain field names and falls back to raw text. Adjust
`parse` in the relevant file if a field comes back empty.

Adding a provider means adding one file to `src/providers/` implementing the
`Provider` type, then listing it in `src/providers/index.ts`.
