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

CI runs on a **self-hosted** runner. Workflows are configured not to run for
pull requests from forks, so a maintainer will need to run the checks for an
outside contribution. Do not add workflows triggered by `pull_request_target`.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
