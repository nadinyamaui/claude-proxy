# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/nadinyamaui/claude-proxy/security/advisories/new)
rather than opening a public issue. Expect an initial response within a few
days.

## Threat model

This project is a thin HTTP wrapper around local coding-agent CLIs. Understand
these properties before deploying it:

- **`/run` is remote code execution by design.** The CLIs it spawns have real
  tool access — they read and write files and run commands inside `WORKDIR`,
  with this process's full environment (including any provider API keys).
  Anyone who can reach `/run` can act as those agents.
- **`PROXY_TOKEN` is required.** The proxy refuses to start without it, so it
  cannot come up unauthenticated. It still binds to `127.0.0.1` by default;
  put it behind TLS before binding to a routable address.
- **The token is compared in constant time**, but it is a single shared
  secret with no rotation, rate limiting, or per-caller identity. Add those at
  your reverse proxy if you need them.
- **Prompts are never shell-interpreted.** They are passed as argv values or
  over stdin to a directly spawned process, so prompt content cannot escape
  into a shell. It _can_ still instruct the agent — treat prompt authors as
  trusted operators.
- **Requests are bounded** by `MAX_BODY_BYTES` and `TIMEOUT_MS`, but `/run`
  has no concurrency limit. A caller can spawn many CLI processes at once.
  Background runs (`/runs`) are queued behind `MAX_CONCURRENT_RUNS` and
  bounded by `RUN_TIMEOUT_MS`, `MAX_UPLOAD_BYTES` and `MAX_UNZIP_BYTES`.
- **Uploaded zips are unpacked with a built-in reader** that rejects absolute
  paths, `..` segments and symlink entries, and refuses archives that would
  expand past `MAX_UNZIP_BYTES`. The extracted tree is still whatever the
  caller sent: the agent runs inside it with full tool access, and files such
  as `.mcp.json`, `CLAUDE.md` or `AGENTS.md` in the upload configure the
  agent. Treat uploaders as trusted operators.
- **Per-run `env` values are passed to the CLI and never written to SQLite**;
  only the variable names are logged. They are held in memory while the run is
  queued or running.
- **`GET /runs/:id/workdir.zip` serves the whole working directory**,
  including anything the agent wrote there. The run API shares the
  `PROXY_TOKEN` gate with `/run` and is meant for a private port.

## Supported versions

This is pre-1.0; only `main` receives fixes.
