# Changelog

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
