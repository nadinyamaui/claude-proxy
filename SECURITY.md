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
- **Auth is off when `PROXY_TOKEN` is unset.** The server binds to `127.0.0.1`
  by default for exactly that reason. Set a strong token _and_ put the proxy
  behind TLS before binding it to a routable address.
- **The token is compared in constant time**, but it is a single shared
  secret with no rotation, rate limiting, or per-caller identity. Add those at
  your reverse proxy if you need them.
- **Prompts are never shell-interpreted.** They are passed as argv values or
  over stdin to a directly spawned process, so prompt content cannot escape
  into a shell. It _can_ still instruct the agent — treat prompt authors as
  trusted operators.
- **Requests are bounded** by `MAX_BODY_BYTES` and `TIMEOUT_MS`, but there is
  no concurrency limit. A caller can spawn many CLI processes at once.

## Supported versions

This is pre-1.0; only `main` receives fixes.
