Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Development

```
$ pnpm test
 Test Files  37 passed (37)
      Tests  383 passed (383)

$ pnpm test:browser
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

```sh
pnpm lint              # eslint, warnings fail
pnpm typecheck         # same tsc -b as pnpm build
pnpm test              # hermetic: no browser, no network
pnpm guard:capability  # dependency + import boundary; determinism on hashed paths
pnpm example           # node examples/quickstart.mjs
pnpm browser:install   # one-time Chromium download, needed only for the next two
pnpm test:browser      # the live suite: real Chromium, real page
pnpm capture <url>     # the documented quickstart
```

`pnpm test` never needs a browser: the capture adapter is tested against a frozen protocol payload in `packages/capture/test/fixtures/cdp-recording.json`, re-recordable with `node packages/capture/scripts/record-fixture.mjs`. The live suite is separate rather than conditionally skipped, so a green `pnpm test` never quietly means "the browser tests did not run". `.github/workflows/ci.yml` runs both, in two jobs.

One file at a time:

```sh
npx vitest run packages/schema/test/query.test.ts
npx vitest run packages/capture/test/transform.test.ts
```

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the conventions that matter, especially the determinism rules on the hashed path and the capability boundary.

### Regenerating the hero

The README hero is a real `pnpm capture https://example.com` run rendered into the shared terminal frame. To refresh it:

```sh
pnpm build
pnpm browser:install                          # once
node packages/capture/dist/cli.js https://example.com > docs/assets/hero-transcript.txt
# paste the transcript into docs/assets/terminal-frame.html's <pre>, then
# screenshot the .frame element with the repo's Chromium at deviceScaleFactor 2 → docs/assets/hero.png
```

`docs/assets/hero-transcript.txt` is committed alongside the image so the PNG stays diffable against a re-run; the snapshot id is content-addressed, so a correct re-run reproduces it byte-for-byte.

## Publishing

Both packages — `@apatureai/lattice` (`packages/schema`) and `@apatureai/lattice-capture` (`packages/capture`) — are prepared for npm: neither is `private` any more, each declares `publishConfig` (`access: public`, `provenance: true`) and a `prepublishOnly` build, and `packages/capture` depends on `packages/schema` via `workspace:*`, which `pnpm publish` rewrites to the concrete published version in the emitted tarball (a plain `npm publish` would leave it unresolvable, so the release workflow uses `pnpm publish`). You can inspect exactly what would ship without publishing anything:

```sh
pnpm build
( cd packages/schema  && pnpm pack )   # 165 files: dist/ + schemas/
( cd packages/capture && pnpm pack )   # 34 files: dist/ incl. the lattice-capture bin
```

Releases are automated. Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds, runs the hermetic test suite, and then `pnpm -r publish --provenance` (walking the workspace in dependency order and skipping the private root).

Two one-time prerequisites gate publishing; both were completed for the 0.1.1 release and are recorded here for reference:

1. **Own the `@apatureai` scope on npm.** The package identity is `@apatureai/*` (`@apatureai/lattice` and `@apatureai/lattice-capture`), so publishing needs whoever owns that npm org. This is a deliberate maintainer decision, not something to work around by minting a new scope.
2. **Add the `NPM_TOKEN` secret.** Create an npm automation (or granular) token with publish rights on the scope and add it as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions). The workflow reads it as `NODE_AUTH_TOKEN`; provenance additionally relies on the workflow's `id-token: write` permission, already declared.

Then, to cut a release: bump the `version` in both `packages/*/package.json` in lockstep, update [`CHANGELOG.md`](../CHANGELOG.md), commit, and `git tag vX.Y.Z && git push --tags`.
