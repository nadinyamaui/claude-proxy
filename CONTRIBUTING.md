# Contributing

Thanks for taking a look. This is a small project; issues and PRs are welcome.

## Getting set up

```bash
npm install
cp .env.example .env
npm test
```

The test suite never calls a provider's API — it drives a stub CLI in
`test/fixtures/`, so it runs offline and costs nothing.

## Before opening a PR

```bash
npm run check
```

That runs the same four things CI does: `format:check`, `lint`, `typecheck`
and `test`. `npm run format` and `npm run lint:fix` apply the automatic fixes.

Please add tests for behavior changes. Provider argument building and output
parsing are pure functions, so they are cheap to cover.

## Adding a provider

1. Add `src/providers/<name>.ts` implementing the `Provider` type from
   `types.ts`: a binary, an `args` builder, an optional `stdin` builder, and a
   `parse` that normalizes output into `{ text, sessionId?, costUsd?, raw }`.
2. Register it in the `providers` map in `src/providers/index.ts`. The
   `ProviderName` union and request validation follow from that map.
3. Add cases to `test/providers.test.ts` covering the flags and the parser,
   including a malformed-output case.

The shared runner handles spawning, timeouts, exit codes and error wrapping —
a provider file should only describe how its CLI differs.

## A note on CI

CI runs on GitHub-hosted runners across Node 22 and 24, and runs on pull
requests from forks. A first-time contributor's run may need a maintainer to
click approve.

Please don't add workflows triggered by `pull_request_target` — it runs
workflow code from the fork with repository secrets in scope.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
