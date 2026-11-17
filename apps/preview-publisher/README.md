# board preview publisher

A static Vercel project that serves an installable `board.tgz` for each
commit. Open the **vboard-preview-publisher** deployment on a PR, copy its
install command into the application, and commit the application's updated
`package.json` and lockfile. Its `npx` line runs that build's `vb` without
installing it.

The install page uses `VERCEL_URL`, the unique deployment URL, even when it's
opened through a branch or production alias. Use that URL in applications. The
tarball keeps the package's current version; the URL and the lockfile's
integrity identify the preview. Nothing is published to npm.

## Vercel project

| Setting                                           | Value                        |
| ------------------------------------------------- | ---------------------------- |
| Project                                           | `vboard-preview-publisher`   |
| Team                                              | `<team>`                      |
| Git repository                                    | `vercel/board`               |
| Root directory                                    | `apps/preview-publisher`     |
| Framework                                         | Other                        |
| Node.js                                           | 24.x                         |
| Include source files outside the root directory   | Enabled                      |
| Automatically expose system environment variables | Enabled                      |
| Deployment Protection                             | Disabled for all deployments |
| Skip unaffected projects                          | Enabled                      |
| Preview and production deployment retention       | 3 years                      |

Build, install, and output settings live in `vercel.json`. Git integration
creates previews and links them on PRs; the Changesets release branch is
excluded. The tarball is built only from `packages/board`, a dependency of
this app, so a PR that doesn't touch either skips its preview.

Applications that install a preview need its deployment: deleting or expiring
one breaks their next install, even with a committed lockfile. Deployments
expire after three years unless covered by a
[retention exception](https://vercel.com/docs/deployment-retention#exceptions-to-the-retention-policy).

The project serves public static files and needs no secrets, functions, or npm
token. Package managers download the tarball from Vercel without
authentication, so a preview of a PR is public once it deploys, though the
repository is private.

## Build and verify

```sh
pnpm --filter vboard-preview-publisher build:preview
python3 -m http.server 4173 --directory apps/preview-publisher/dist
```

In another terminal:

```sh
DEPLOYMENT_URL=http://localhost:4173 pnpm --filter vboard-preview-publisher test:smoke
```

For a deployed preview, set `DEPLOYMENT_URL` to its full HTTPS URL, and
optionally `EXPECTED_COMMIT` to the PR's head SHA to check provenance. The smoke
check makes unauthenticated requests, rejects redirects, checks the tarball's
integrity, and installs its URL in a temporary npm project. It imports
`@vercel/board` and `@vercel/board/backend-local`, runs `vb --version`, and
checks that the docs and the inspector's bundle shipped.

The build packs `packages/board` with `pnpm pack`, whose `prepack` builds it.
Its script isn't `build`, so the root's `pnpm build` (which CI runs) doesn't
rebuild `packages/board/dist` while the apps' builds are reading it.
`VERCEL_URL` and `VERCEL_GIT_COMMIT_SHA` come from Vercel; a local build uses
`http://localhost:4173` and the current Git HEAD.

A CLI upload has no Git checkout, so it needs the commit given explicitly. From
the repository root:

```sh
vercel deploy --project vboard-preview-publisher --scope <team> \
  --build-env VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)"
```

Publish a preview of a commit from a clean checkout. A local build or CLI upload
includes working-tree changes, while its metadata records Git HEAD.
