# Contributing

`@vercel/board` is one package, in `packages/board`: `board()`, its backends,
and the CLI (`board`, alias `vb`). [SPEC.md](./SPEC.md) is the design; read it
before changing behavior.

## Running the tests

The tests need no credentials and create nothing outside your machine.

```bash
pnpm install
pnpm check   # build, typecheck, and test
pnpm test    # vitest: unit, in-process server, and the CLI end to end
```

Tests use the same pieces as any board (`packages/board/test/harness.ts`): an
in-memory store and blob store, and a local test issuer. Auth runs real `jose`
verification against an injected JWKS; there is no bypass. A test should fail
when the behavior it claims breaks, and pin nothing a user can't observe.

## Pull requests

- Title it `<type>(<area>): <what it does>`, in the imperative, about 60
  characters: `fix(store): split big redisTables writes into bounded scripts`.
  `type` is `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, or `chore`, with
  `!` when it breaks someone.
- Open the body with one line on what it does and for whom, then answer four
  questions, each `none` when nothing applies: **Users**, **Protocol /
  backends**, **Performance / I/O**, and **Tests**.
- A change people will notice gets a changeset (`pnpm changeset`). Users is
  `none` exactly when there is no changeset.
- A bug fix names the test that fails without it. A UI change has a screenshot.

CI runs `pnpm check` on every PR; its `check` job has to pass before a PR can
land.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
