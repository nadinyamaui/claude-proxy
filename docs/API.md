# claude-proxy API reference

An HTTP API in front of the `claude`, `codex` and `grok` command-line agents.
Two ways to run a prompt:

- **`POST /run`** runs the CLI and waits for the answer. Good for short
  questions.
- **`POST /runs`** uploads a working directory as a zip, runs the CLI inside it
  in the background, and lets you poll status and logs and download the
  result. Good for long agent sessions.

All responses are JSON unless noted. Timestamps are ISO 8601 in UTC.

## Base URL and authentication

The proxy listens on `http://127.0.0.1:8787` by default (`HOST`, `PORT`).

`PROXY_TOKEN` is required — the proxy refuses to start without it. Every
endpoint except `GET /health` requires:

```
authorization: Bearer <token>
```

A missing or wrong token returns `401 { "error": "unauthorized" }`. The token
is compared in constant time.

## Error shape

Every error is `{ "error": "<message>" }`, sometimes with extra fields.

| status | meaning                                                                               |
| ------ | ------------------------------------------------------------------------------------- |
| `400`  | Malformed request: missing prompt, unknown provider, bad zip, bad `env` or `baseUrl`. |
| `401`  | Missing or wrong bearer token.                                                        |
| `404`  | Unknown path or run id.                                                               |
| `405`  | Wrong method. The `allow` header lists what the path accepts.                         |
| `409`  | The run is already finished (cancel).                                                 |
| `410`  | The run's working directory no longer exists (download).                              |
| `413`  | Body over `MAX_BODY_BYTES` (`/run`) or `MAX_UPLOAD_BYTES` (`/runs`).                  |
| `415`  | `POST /runs` was not `multipart/form-data`.                                           |
| `502`  | The CLI failed (`/run` only; see below).                                              |
| `500`  | Unexpected proxy error.                                                               |

## Providers

| provider | notes                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| `claude` | Default. Session resume and system prompt supported. Streams events into background logs. |
| `codex`  | System prompt is prepended to the prompt. Streams JSONL into background logs.             |
| `grok`   | No streaming mode; background logs contain the final output only.                         |

### Per-request API key and endpoint

`POST /run` and `POST /runs` both accept `apiKey` and `baseUrl`. They are
passed to the CLI as the environment variables it already reads, for that
one invocation only, so a request can use a different account or point at a
gateway without changing the proxy's own login:

| provider | `apiKey` sets                        | `baseUrl` sets       |
| -------- | ------------------------------------ | -------------------- |
| `claude` | `ANTHROPIC_API_KEY`                  | `ANTHROPIC_BASE_URL` |
| `codex`  | `OPENAI_API_KEY` and `CODEX_API_KEY` | `OPENAI_BASE_URL`    |
| `grok`   | `GROK_API_KEY`                       | `GROK_BASE_URL`      |

**When they are omitted**, nothing is added and the CLI authenticates exactly
as it would on its own, with the account it is logged into on the proxy host.
Each field is independent:

| request sends       | API key used        | endpoint used     |
| ------------------- | ------------------- | ----------------- |
| neither             | the CLI's own login | the CLI's default |
| `apiKey` only       | `apiKey`            | the CLI's default |
| `baseUrl` only      | the CLI's own login | `baseUrl`         |
| `apiKey`, `baseUrl` | `apiKey`            | `baseUrl`         |

"The CLI's own login" includes the proxy's environment: if the operator set
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `GROK_API_KEY`, or a `*_BASE_URL`
variable) in the proxy's `.env`, a request that omits the field uses that
value, since the CLI prefers it over its stored login.

`baseUrl` must be an `http` or `https` URL. The key is never put in argv,
never stored with a run and never logged; for background runs only the
variable names appear in the log.

---

## `GET /health`

No auth. Confirms the proxy is up and lists providers.

```json
{ "ok": true, "providers": ["claude", "codex", "grok"] }
```

---

## `POST /run`

Synchronous run. The request blocks until the CLI exits, up to `TIMEOUT_MS`
(default two minutes). Runs inside the proxy's `WORKDIR`.

**Request** (`application/json`)

| field          | required | description                                                                                       |
| -------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `prompt`       | yes      | Non-empty string.                                                                                 |
| `provider`     | no       | `claude` (default), `codex` or `grok`.                                                            |
| `sessionId`    | no       | Resume a session returned by an earlier run.                                                      |
| `model`        | no       | Provider-specific model id.                                                                       |
| `systemPrompt` | no       | Extra instructions.                                                                               |
| `apiKey`       | no       | API key for this call. See [Per-request API key and endpoint](#per-request-api-key-and-endpoint). |
| `baseUrl`      | no       | API endpoint for this call (`http`/`https`).                                                      |

**Response `200`**

```jsonc
{
  "provider": "claude",
  "text": "…", // the final answer
  "sessionId": "…", // pass back as sessionId to continue the conversation
  "costUsd": 0.068, // present when the provider reports it
  "raw": {}, // the provider's untouched output
}
```

**Response `502`** when the CLI fails:

```json
{ "error": "claude exited with code 1", "provider": "claude", "exitCode": 1, "detail": "<stderr>" }
```

**Example**

```bash
curl -s localhost:8787/run \
  -H "authorization: Bearer $PROXY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"Reply with exactly: PONG"}'
```

---

## `POST /runs`

Start a background run. Returns as soon as the run is queued.

**Request** (`multipart/form-data`)

| field          | required | description                                                                                                                                                                        |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | yes      | Non-empty string.                                                                                                                                                                  |
| `zip`          | no       | A zip file. It is unpacked into a fresh directory that becomes the CLI's working directory.                                                                                        |
| `provider`     | no       | `claude` (default), `codex` or `grok`.                                                                                                                                             |
| `model`        | no       | Provider-specific model id.                                                                                                                                                        |
| `systemPrompt` | no       | Extra instructions.                                                                                                                                                                |
| `sessionId`    | no       | Resume a session.                                                                                                                                                                  |
| `env`          | no       | JSON object of string values, e.g. `{"WEBSITE_BUILD_MCP_TOKEN":"…"}`. Added to the CLI's environment for this run only. Values are never stored; only the names appear in the log. |
| `apiKey`       | no       | API key for this run. Wins over the same variable in `env`. Never stored.                                                                                                          |
| `baseUrl`      | no       | API endpoint for this run (`http`/`https`). Wins over the same variable in `env`.                                                                                                  |

Without a `zip`, the run gets an empty directory.

**Zip rules.** Stored and deflate-compressed entries are supported. Zip64
(over 4 GB or more than 65535 entries) and encrypted archives are not.
Entries with absolute paths, `..` segments or symlinks are rejected, as are
archives that would expand past `MAX_UNZIP_BYTES` (default 1 GB). A bad
archive is a `400`, and no run is created. The archive's contents are used
as-is, so files the CLI reads from its working directory such as
`.mcp.json`, `CLAUDE.md`, `AGENTS.md` or `.agents/skills/` take effect.

**Response `202`** with a run record (see below). The status may already be
`running` if the queue was free.

**Example**

```bash
curl -s localhost:8787/runs \
  -H "authorization: Bearer $PROXY_TOKEN" \
  -F prompt="Build the site described in PRODUCT.md" \
  -F zip=@website-build-69.zip \
  -F env='{"WEBSITE_BUILD_MCP_TOKEN":"…"}'
```

### The run record

```jsonc
{
  "id": "6f1c2a4e-…", // UUID
  "status": "running", // queued | running | succeeded | failed | cancelled
  "provider": "claude",
  "prompt": "…",
  "model": null,
  "systemPrompt": null,
  "sessionId": null, // the session that was resumed, if any
  "zipName": "website-build-69.zip", // null when no zip was uploaded
  "workdir": "/srv/proxy/runs/6f1c2a4e-…", // on the proxy host
  "createdAt": "2026-09-15T17:00:00.000Z",
  "startedAt": "2026-09-15T17:00:00.020Z", // null while queued
  "finishedAt": null, // set when terminal
  "exitCode": null, // the CLI's exit code once it exits
  "error": null, // message when failed or cancelled
  "result": null, // see below once succeeded
}
```

`result` has the same shape as the `POST /run` response minus `provider`:

```jsonc
{ "text": "…", "sessionId": "…", "costUsd": 0.42, "raw": {} }
```

**Status lifecycle.** `queued` → `running` → one of `succeeded`, `failed`,
`cancelled`. At most `MAX_CONCURRENT_RUNS` (default 2) execute at once; the
rest wait in order. A run is killed and marked `failed` after
`RUN_TIMEOUT_MS` (default one hour). If the proxy restarts, runs that were
queued or running are marked `failed` with the error
`proxy restarted while the run was in progress`.

---

## `GET /runs`

List runs, newest first. `result.raw` is omitted from listings.

| query    | default | description               |
| -------- | ------- | ------------------------- |
| `status` | all     | One of the five statuses. |
| `limit`  | `50`    | Max `500`.                |

```json
{ "runs": [{ "id": "…", "status": "succeeded", "…": "…" }] }
```

---

## `GET /runs/:id`

The full run record, including `result.raw`. `404` if unknown.

---

## `GET /runs/:id/logs`

Log lines, oldest first. Use this to follow a run while it works.

| query   | default | description                                       |
| ------- | ------- | ------------------------------------------------- |
| `after` | `0`     | Only return lines with an `id` greater than this. |
| `limit` | `1000`  | Max `10000`.                                      |

```jsonc
{
  "id": "6f1c2a4e-…",
  "status": "running", // the run's current status
  "lines": [
    {
      "id": 1,
      "ts": "2026-09-15T17:00:00.001Z",
      "stream": "proxy",
      "line": "extracted website-build-69.zip: 20 files, 5027740 bytes",
    },
    { "id": 4, "ts": "…", "stream": "stdout", "line": "{\"type\":\"system\",\"subtype\":\"init\",…}" },
    { "id": 5, "ts": "…", "stream": "stderr", "line": "…" },
  ],
  "next": 5, // pass back as ?after= to fetch only newer lines
}
```

`stream` is one of:

- `stdout`: one line of the CLI's output. For claude this is one JSON event
  per line (`system`, `assistant`, `user`, `result`). For codex, one JSONL
  event. For grok, the final output.
- `stderr`: one line of the CLI's stderr.
- `proxy`: lifecycle notes from the proxy: extraction, env variable names,
  queue position, start, exit, timeout, cancellation.

**Polling pattern.** Call with `after=<next>` from the previous response,
repeat until `status` is `succeeded`, `failed` or `cancelled`, then fetch
`GET /runs/:id` for the result. When `lines` is empty, `next` echoes
`after`.

```bash
NEXT=0
while :; do
  PAGE=$(curl -s "localhost:8787/runs/$ID/logs?after=$NEXT" -H "authorization: Bearer $PROXY_TOKEN")
  echo "$PAGE" | jq -r '.lines[] | "\(.stream): \(.line)"'
  NEXT=$(echo "$PAGE" | jq .next)
  case $(echo "$PAGE" | jq -r .status) in succeeded|failed|cancelled) break;; esac
  sleep 2
done
```

---

## `GET /runs/:id/workdir.zip`

Download the run's working directory as it is right now, including any
files the agent created or changed. Works while the run is still running.
Symlinks are skipped. Response is `application/zip` with a
`content-disposition: attachment; filename="<id>.zip"` header.

`410` if the directory has been deleted.

```bash
curl -s "localhost:8787/runs/$ID/workdir.zip" -H "authorization: Bearer $PROXY_TOKEN" -o result.zip
```

---

## `POST /runs/:id/cancel`

Stop a queued or running run. A queued run never starts. A running run's
CLI receives `SIGTERM`, then `SIGKILL` five seconds later. The response is
the run record with `status: "cancelled"` once it has fully stopped.

`409` if the run had already finished.

---

## `DELETE /runs/:id`

Remove the run record, its logs and its working directory. Cancels the run
first if it is still queued or running.

```json
{ "deleted": "6f1c2a4e-…" }
```

---

## Operator settings

Set in the proxy's `.env`. Relevant to API callers:

| variable              | default      | effect                                                  |
| --------------------- | ------------ | ------------------------------------------------------- |
| `PROXY_TOKEN`         | **required** | Bearer token; the proxy will not start without it.      |
| `TIMEOUT_MS`          | `120000`     | `POST /run` timeout.                                    |
| `MAX_BODY_BYTES`      | `1000000`    | `POST /run` body cap.                                   |
| `RUN_TIMEOUT_MS`      | `3600000`    | Background run timeout.                                 |
| `MAX_UPLOAD_BYTES`    | `100000000`  | `POST /runs` body cap, including the zip.               |
| `MAX_UNZIP_BYTES`     | `1000000000` | Cap on what a zip may expand to.                        |
| `MAX_CONCURRENT_RUNS` | `2`          | Background runs executing at once.                      |
| `RUNS_DIR`            | `runs`       | Where working directories and the SQLite database live. |
