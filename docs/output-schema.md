# Output schema

## capture.js

| File | Content |
|---|---|
| `summary.md` | **Read this first**: file composition (markup/CSS/JS bytes + token estimate), screen inventory table, entry click stats, breakpoints, theme states, overlays, iframe recursion stats, broken resources |
| `prototype.json` | Full structured data (see below) |
| `screen-NN.png` | One screenshot per screen (visual baseline) |

### prototype.json

Page level:

| Key | Content |
|---|---|
| `pages[].screens[]` | One entry per captured screen: `name`, `entry`, `heading`, `shot`, `elementCount`, `tree`, `interactions` |
| `pages[].overlays[]` | Modals / drawers / toasts, including hidden ones with their subtree (`hiddenNow` flag) |
| `pages[].css` | Rule counts, `:hover` / `:focus` / pseudo-element rule counts, `mediaConditions`, deduplicated `breakpoints[]`, `customPropsByState` (theme variables per selector), `fontFaces[]` |
| `pages[].theme` | Theme toggle probe: whether a toggle was found plus key element colours before/after |
| `pages[].iframes` | Recursion stats: total, `sameOriginRecursed`, `crossOriginOrBlocked` |
| `pages[].deadContent` | Multi-version / dead-content report: `css` (`staticChecked`, `matchedNow`, `dormantCount/Samples` — tokens seen on other screens, `notSeenInCaptureCount/Samples` — never seen during capture, may activate on unvisited screens, theme states or deep entries), `duplicateIds`, `versionResidueClasses` (`-old` / `-v2` / `-backup` patterns), `hiddenBranches` (label, subtree size, interactive count) |
| `pages[]` | `entriesFound`, `entriesClicked`, `failedRequests`, page title/height, channel used |
| `fileComposition` | Total bytes, token estimate, markup/CSS/JS split — decides whether naive reading was ever viable |
| `schemaVersion` | Artifact schema version (bump on breaking field changes) |
| `warnings[]` | Every degraded step (`page`, `stage`, `message`) — empty means nothing was silently skipped. Also mirrored per page |
| `externalHosts` | Hosts the prototype requested beyond file/localhost — a security signal; `--no-network` blocks them |
| `options` | Effective run options (viewport, maxScreens, timeoutMs, shotFormat, noNetwork) |

Component tree node fields:

| Field | Meaning |
|---|---|
| `t` | Tag name |
| `id`, `c` | Element id and class array |
| `r` | `{x, y, w, h}` from `getBoundingClientRect` |
| `v` | Visibility flag |
| `rep` | Number of consecutive identical siblings folded into this node |
| `s` | Style diff against the parent (non-inherited differences only) |
| `ps` | Pseudo-elements: `content`, `position`, decorative flag, key visual properties |
| `sem` | Semantic attributes and live state: role, aria-* (incl. aria-checked/selected/expanded/pressed/valuenow), alt, placeholder, name, type, href, disabled, required, `checked`/`indeterminate` (checkbox/radio, read as property), `value` (input/textarea/select — property, so JS-set values are captured), `selected`/`options`/`multiple`/`optionCount` (select), `open` (dialog/details), `value`/`max` (progress/meter), `list` (datalist), `editableText` (contenteditable) |
| `tx` | Leaf text (trimmed, visible elements only) |
| `ch` | Children |
| `img` / `canvas` / `iframe` | Resource info; `iframe.content` holds the recursed same-origin subtree |

### Suggested consumption order (for the restoring agent)

1. `summary.md` for the global picture.
2. Screenshots for the visual baseline.
3. `tree` per screen: skeleton first (`t`/`c`/`r`/`rep`), then drill into `s`.
4. `interactions` for every control, including overlay membership.
5. Restore against: every breakpoint, both theme states, decorative pseudo-element layers, hidden overlay triggers and broken references.

## diff.js

| File | Content |
|---|---|
| `diff-report.md` | **Read first**: ratio overview, hotspot table labelled by document outline, style-mismatch list, missing classes/text/interactions |
| `diff-overlay.png` | Difference overlay with differing pixels in red |
| `prototype.png` / `restored.png` | The two screenshots actually compared |
| `diff.json` | Full data: pixel stats (incl. `truncated` / `fullHeight` / `overlay`), structure diff, hotspots, warnings, failed requests |

`diff.json` also carries `schemaVersion`, `structureOk`, `warnings[]` and `pixelSkipped`. When a dimension could not be measured, `structure` / `pixel` are `null` (never zeros) and the process exits with code 2.
