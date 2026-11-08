# TODO

## Learning the tables on the boat

Read the boat's sailing from the Signal K v2 History API, reduce it to what the fits need, and
fit on request from a Learn page, applied only on **Save**. SPECIFICATION.md §11.

Done:

- `lib/learn.js`: classes, events, legs, day-file records. Replayed on boatcal's history, it
  finds the same manoeuvres and legs as boatcal on both setups (§11.8).
- `lib/history.js`: a local day from the History API, every path from a named source.
- Raw STW published on `navigation.speedThroughWaterRaw` (§7.5), so it reaches history in
  Replace mode.
- `PUT /learn/scan {since, until}`, `GET /learn/status`: the scan into day files.

Next:

1. Deploy to the boat and let real sailing reach history with `speedThroughWaterRaw`; scan a
   day and compare it with the same day in boatcal (events, legs, tables).
2. A read-only Learn page: days scanned, tacks, gybes, roundings, legs, support per cell.
3. Port the fits (TWA and TWS first, then STW and K), each checked against boatcal on the
   same day files. Two copies can drift, so boatcal stays the reference.
4. Propose and **Save**.

Open questions:

- How long a fit takes on a Raspberry Pi, and whether it must run in the background.
- Other providers (signalk-to-influxdb2, signalk-parquet): checked only from their code, not
  run. signalk-questdb is checked on sk.local.
- Report upstream: the server's REST History API strips `-` from a sourceRef (2.36).

## boatcal for schema 7 (grid tables)

Done in boatcal's working tree (2026-11-08, not committed): it writes schema 7 configs and fits
the fine grids of `lib/defaults.js`, B&G compatibility dropped. Left:

- Run it on the database, both setups, and score the fine grids held out against the H5000
  layout (boatcal SPECIFICATION.md section 11).
- Then refit `lib/defaults.js` from a real fine-grid fit, and update its note.

The guide for an AI agent fitting a user's tables is now in AGENTS.md ("Calibrating a boat"). Try it
on a real data set from someone else's boat, and fix what it misses.
