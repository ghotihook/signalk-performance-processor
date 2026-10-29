# Changelog

## 0.0.6 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments. Validated against 19 races of 2026 logs; the tables are unchanged.

- **Fix: TWD followed the bow through every tack.** The TWA correction was applied in full right up to head to wind, so any \|TWA\| smaller than the correction read exactly 0° and TWD equalled heading for that part of the tack (correction jumps of up to 22° in a second in race logs). It now fades out over the last 30° to head to wind.
- **Fix: TWA jumped crossing dead downwind** when the downwind correction was negative (5–7° in 7–12 kn of TWS). It now fades out over the last 10° to dead downwind.
- The TWA table's values must now be within ±30° (upwind) and ±10° (downwind), and its row angles outside the fades, so corrected TWA always moves with uncorrected TWA.
- **Fix: leeway snapped from 0° to the 15° cap** as the boat reached 1 kn, and sat at the cap up to about 2.5 kn. It now fades in between 1.5 and 3 kn.
- **Light air:** below 1.5 kn of TWS, TWA and TWD are not published and the status and Live page say so; they return from 2 kn.
- **Self-documenting limits:** each correction on the Calibration page lists its built-in limits (TWA fades and value limits, leeway cap and fade-in, STW taper below the first speed column), and Settings lists light air, stale inputs, the rate limit and implausible input. The numbers come from the plugin's own constants via `GET /calibration`, so the text cannot drift from the code.
- Fix: when STW went stale, the status named the paddlewheel as if it were another plugin. It now names only plugin sources.

## 0.0.5 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- **Fix: feedback loop with another STW plugin in Replace mode.** With `signalk-stw-heel-correction` (0.2 or earlier) on the same server, each plugin corrected the other's STW and handed it back, so STW and true wind ran away. Without a chosen STW source, STW is now read from sensors only (updates that carry a `source` object from a data connection), never from another plugin. Choosing a source in Settings still overrides this.
- **Rate limit as a circuit breaker:** no path is published more often than 20 Hz. A feedback loop is cut at its first repeat, and a backlog flushed after a dropout is thinned rather than stopped; nothing latches. While updates are being dropped, the status and the Live page say so, with a count and the source driving them, for 10 s after the last one; the first is logged.
- The status says when STW is arriving only from other plugins, and names them.
- Settings: the STW source's blank choice reads **Auto (sensors only)**.

## 0.0.4 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments. Saved configurations are upgraded to schema 2 on first load.

- **STW correction is a heel × speed table** (signed heel rows, STW columns), like the H5000's boat speed / heel table, with bilinear interpolation and blank cells filled from the nearest value. The default is the owner's full measured table. A table in the `signalk-stw-heel-correction` CSV format can be pasted into the webapp.
- **TWS table is in knots** (H5000 units). Default downwind −0.5 … −3 kn (−10% of each column); upwind and reach blank, meaning no correction.
- **New TWA table defaults** from the owner's calibration fit. Blank TWA cells mean too little data and use the nearest measured cells in the row.
- Config file schema 2. Schema 1 files are upgraded on load: the two STW rows become their grid and TWS percentages become knots.
- Live pipeline: each step's result is tagged **Published** or **Working**, worked out from what later enabled steps replace, so intermediate values are not mistaken for outputs.
- Calibration tables: the breakpoints (TWS columns, STW speeds, heel angles) are fixed labels, not editable fields; only the correction values are edited.
- Live page: a "Published to Signal K" table lists exactly what the plugin sends and on which path. The pipeline's true wind step is labelled "before tables", so its working TWA is not mistaken for a second output.

## 0.0.3 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- Fix: the Calibration and Settings pages were empty on a real server. The plugin's `/config` endpoint was shadowed by the server's own route of that name; it is now `/calibration`, and the webapp says so if the calibration cannot be loaded.
- README and App Store description explain the problem this solves, who it is for, and the results on the boat it was built for.

## 0.0.2 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- Heading for TWD and current comes from `navigation.headingTrue` if present, otherwise magnetic heading plus `navigation.magneticVariation` (normally from the GPS). The variation in Settings is now only a fallback, and the Live page says which is in use.
- Configuration is edited only in the webapp and saved to `config.json` in the plugin's data directory. The admin Plugin Config form no longer shows the tables, so saving it cannot overwrite them. A configuration saved by 0.0.1 is picked up until the webapp first saves.
- The configuration file records its format version (`"schema": 1`). Future releases upgrade older files as they load; a file from a newer release is refused and never overwritten.

## 0.0.1 — 2026-10-29

First release, a proof of concept. Run it in Shadow mode alongside your instruments before relying on it.

- Corrections, each with an on/off switch: boat speed (linearity by speed plus heel correction), leeway (K × heel ÷ STW²), and H5000-style TWA and TWS tables with upwind, reach and downwind rows by TWS.
- True wind from apparent wind minus boat velocity including leeway; TWD from heading and variation; current from SOG/COG.
- Shadow mode publishes `…Corrected` paths; Replace mode publishes the standard paths under the plugin's own source for Source Priorities.
- Webapp with Live, Calibration and Settings pages. Configuration is saved as the plugin's options and validated before it is applied.
- Ships with this boat's defaults: the owner's STW table and leeway K, and TWA/TWS tables fitted to the 2025 race logs.
- Loop guard, input plausibility checks, a choice of source per input, and a test suite.
