# CLI reference

Both tools are plain Node scripts. `npm run capture -- <args>` and `npm run diff -- <args>` are equivalent shortcuts.

## capture.js

```bash
node scripts/capture.js <html-file-or-dir> <output-dir> [options]
```

| Option | Default | Description |
|---|---|---|
| `--viewport WxH` | `1440x900` | Render viewport; use `375x812` for mobile restorations |
| `--max-screens N` | `30` | Screen-count cap for traversal, guarding against entry-click loops |
| `--timeout ms` | `45000` | Page load timeout |
| `--shot-format` | `png` | `png` or `jpeg` for per-screen baselines; `jpeg` is much smaller for long pages |
| `--jpeg-quality N` | `82` | JPEG quality when `--shot-format jpeg` |
| `--no-network` | off | Block every non-file:// or localhost request before it leaves the machine (use for prototypes from an untrusted source) |
| `DEBUG=1` (env) | off | Per-screen capture log (entry hits / click failures / dedup results) — enable when screens go missing |

A directory input is processed page by page in filename order.

## diff.js

```bash
node scripts/diff.js <prototype.html|URL> <restored.html|URL> <output-dir> [options]
```

| Option | Default | Description |
|---|---|---|
| `--threshold N` | `32` | Pixel-diff threshold (max per-channel delta); raise to tolerate anti-aliasing noise |
| `--block N` | `100` | Hotspot block edge in px; lower for finer localization |
| `--viewport WxH` | `1440x900` | Both sides must use the same viewport, otherwise a size mismatch is reported |
| `--max-height px` | `12000` | Pages taller than this are compared in bands up to the cap; the report marks the result truncated |
| `--overlay-format` | `png` | `png` or `jpeg` for the difference overlay image |

## Warnings and exit codes

Both tools record every degraded step in a `warnings[]` array (also listed at the top of `summary.md` / `diff-report.md`) and add `schemaVersion` to their artifacts.

| Exit code | Meaning |
|---|---|
| 0 | Measured, no problems detected |
| 2 | A dimension could not be measured (snapshot failed, or the page could not be loaded) — `structure` / `pixel` are `null`, never zeros. **Not a pass.** |
| 1 / 3 | Tool-level failure (bad arguments, no browser available) |

## Reading the result

Pixel difference ratio below 1% with no style mismatches means consistent. Between 1% and 5%, check whether the hotspots concentrate in motion or icon areas before chasing them. Above 5%, work through the hotspots region by region.

The diff always compares the **initial render state** of both sides. For a multi-screen prototype, restore screen by screen using the capture inventory and run the diff once per screen.

## Scenario advice

- **Screens missing from capture** — run with `DEBUG=1` and read the per-entry log; for prototypes with unusual navigation, extend the entry selectors.
- **Many false style differences** — raise `--threshold` (for example `48`). Residual differences inside icon or font-rendering areas can usually be ignored.
- **Dark/light themes** — capture already reports `customPropsByState` and the theme probe; implement both sets and run the diff once per theme state.
- **Context overflow** — read `summary.md` and the screenshots first, then drill into `prototype.json` per screen or subtree. Never ingest it whole.
