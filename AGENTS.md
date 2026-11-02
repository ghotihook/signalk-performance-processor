# Agent instructions

Signal K plugin and webapp that calibrates true wind. [README.md](README.md) says what it does and how it is used; [SPECIFICATION.md](SPECIFICATION.md) holds the maths. This file is only what those do not say.

## Commands

- `npm test` runs everything. There are no dependencies and no build step.
- Commit, tag, push or publish only when asked.

## Rules

- **The specification is the master record of the maths.** Change it in the same commit as the code, and add a `CHANGELOG.md` entry.
- **boatcal's `plugincal` runs this code.** It uses `lib/processor.js` (its exports and `_internals`) and `public/tables.js`: check `plugincal/pipeline.js` before changing them.
- **`lib/processor.js` stays free of Signal K**, so it can be tested and replayed. Anything Signal K goes in `index.js`.
- **Units:** degrees and knots inside the pipeline, radians and m/s in Signal K. Keep the sign conventions in specification §1.
- **A change to the config layout** means bumping `CONFIG_SCHEMA`, adding an upgrade path and testing it. Never overwrite a file from a newer release.
- **No feedback loops.** The plugin never reads its own output, and reads another plugin's only if that source is chosen in Settings.
- **`plugin.schema` stays empty.** Everything is set in the webapp: saving the admin form could otherwise overwrite the tables.
- **Don't add `GET` or `POST /config` routes.** The server owns them on every plugin's router.

## Gotchas

- **The webapp has no tests.** Check its changes in a browser. Most boats reach Signal K over plain `http://`, where browsers offer no `navigator.clipboard`, and `localhost` hides that: test on a LAN address.
- **Live page step boxes are a fixed size on purpose**, so values don't shift the layout.
- **A blank table cell** takes the value to its left, or at the start of a row the first value to its right (`fillGaps`). Don't call it "nearest".
- **`lib/defaults.js` is one real boat's calibration.** Change it only from a `plugincal` fit, and update the note at the top saying where it came from.
- **Screenshots** in `docs/screenshots/` are listed in `package.json` and shown in the README. Regenerate them when the UI text or defaults change; the tooling is not in this repo.

## Release

1. Bump the version in `package.json` and add the `CHANGELOG.md` section (`## x.y.z — date`).
2. Update the "Written for" line in `SPECIFICATION.md`.
3. Merge to `main`.
4. Tag `vx.y.z` and push it: that makes the GitHub release from the changelog section and runs Signal K's plugin CI.
5. `npm publish`.
