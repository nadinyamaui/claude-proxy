---
name: add-provider
description: Add a new coding-agent CLI (like gemini, aider, or another claude-style tool) as a provider behind POST /run. Use when asked to support an additional CLI, model backend, or agent in this proxy.
---

# Adding a provider

Every provider is one file in `src/providers/` implementing the `Provider`
type. The shared runner in `src/providers/index.ts` owns spawning, timeouts,
exit codes and error wrapping — a provider file only describes how its CLI
differs.

## 1. Learn the CLI's real interface first

Do not guess flags. Run these and read the output:

```bash
<bin> --help
```

You need four facts:

| Question                                         | Where it goes    |
| ------------------------------------------------ | ---------------- |
| How does it run non-interactively and emit JSON? | `args`           |
| Does the prompt go in argv or on stdin?          | `args` / `stdin` |
| How does it resume a session?                    | `args`           |
| What does a success payload look like?           | `parse`          |

If the CLI is not authenticated, you can still confirm argv handling from its
error output, but say so — do not claim a parser is verified when it isn't.

## 2. Write the provider

Create `src/providers/<name>.ts`:

```ts
import type { Provider, RunRequest, RunResult } from "./types.js";

export const <name>: Provider = {
  name: "<name>",
  bin: process.env["<NAME>_BIN"] || "<name>",
  args(req: RunRequest): string[] { /* flags only */ },
  stdin(req: RunRequest): string { /* optional; defaults to req.prompt */ },
  parse(stdout: string): Omit<RunResult, "provider"> {
    return { text, sessionId, costUsd, raw };
  },
};
```

Rules that matter:

- **Never build a shell string.** Return an argv array; the runner spawns
  without a shell, which is what keeps prompts from being interpreted.
- **`parse` should throw on an error payload** — the runner turns that into a
  502 carrying the CLI's own message.
- **Omit optional fields rather than setting them undefined.**
  `exactOptionalPropertyTypes` is on, so build the object then conditionally
  assign `sessionId` / `costUsd`.
- If the CLI has no system-prompt flag, prepend `req.systemPrompt` to the
  prompt in `stdin` instead, as `codex.ts` does.

## 3. Register it

Add it to the `providers` map in `src/providers/index.ts`. The `ProviderName`
union, `isProviderName`, request validation and the `/health` listing all
derive from that map — nothing else needs editing.

## 4. Test and document

- Add a block to `test/providers.test.ts`: the flag mapping, a success parse, a
  missing-optional-fields parse, and a malformed-output case.
- Add `<NAME>_BIN` to `.env.example`.
- Add a row to the provider table in `README.md`, and note honestly whether the
  success payload was verified against a signed-in CLI.

## 5. Verify

```bash
npm run check
```
