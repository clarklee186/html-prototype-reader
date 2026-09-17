# html-prototype-reader

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-blue)
![Runtime](https://img.shields.io/badge/runtime-playwright--core%20%2B%20Chrome%2FEdge-orange)

A **render-based HTML prototype reader and acceptance-diff toolkit for AI agents**. It turns HTML prototypes exported from design tools (single-page, multi-page, or JS-assembled) into structured facts an agent can consume directly — component tree + computed styles + semantic annotations — and provides an acceptance diff between the restored page and the prototype (same-viewport pixel comparison + structural / style / interaction discrepancy report).

## Why it exists

Reading HTML source directly ("naive reading") causes systematic omissions for agents:

- **Computed styles do not exist in source** — CSS cascade, inheritance, browser defaults, and the resolved values behind `var()` references are only knowable after real rendering. In one measured prototype there were 1,201 `var()` references across 37 custom properties; naive reading means mentally simulating the renderer.
- **Layout geometry does not exist in source** — absolute-position coordinates, actual flex/grid arrangements, real element widths and heights.
- **Pure parsers cannot produce layout** — jsdom has no layout engine (`getBoundingClientRect` always returns 0) and does not implement pseudo-element computed styles.
- **Dynamic prototypes are unreadable at source level** — in one measured 783 KB prototype, static HTML was only 1 KB while 650 KB was JavaScript; every screen was assembled at runtime via `innerHTML`, and 6 of 7 screens were initially invisible.
- **Context truncation** — a 220k-token prototype fits barely half of its source into a typical context window.

This tool renders in a real browser and extracts facts, turning guesses into reads. The acceptance diff turns "does the restoration look right" from an eyeball judgment into an item-by-item fix list.

## Features

### capture.js — prototype capture (four modules)

| Module | Capability |
|---|---|
| **extract** | Full DOM traversal + `getBoundingClientRect` layout geometry + computed-style whitelist capture (diffed against the parent, keeping only non-inherited differences — compression for free) |
| **traverse** | Automatic entry discovery (nav / tabs / `data-view` etc.) → click each → visible-element signature deduplication → per-screen screenshots. Multi-screen JS-assembled prototypes require this path; plain rendering misses 6 of 7 screens |
| **compress** | Repeated sibling subtrees folded by structural signature (`rep: N`), style inheritance diff, px rounding |
| **output** | `prototype.json` + `summary.md` + per-screen screenshots |

Detail dimensions covered: pseudo-elements (`::before/::after`, including `content:''` + absolutely-positioned decorative layers), interactive-element inventory (button/input/select/textarea/[role] with disabled / required / placeholder / overlay membership), resource references (img/srcset/background-image/@font-face, broken-reference detection), **responsive breakpoint inventory** (all `@media` conditions deduplicated from the CSSOM), **theme-state probe** (detects theme toggles, records effective colors of key elements before/after), modal / drawer / toast inventory (hidden ones included with subtree structure), same-origin iframe recursion, canvas size recording, lazy-loading fallback (IntersectionObserver stub + `loading=eager` + full-page scroll).

### diff.js — restoration acceptance

- **Pixel comparison**: same-viewport fullPage screenshots of both sides, per-pixel threshold comparison, differing pixels highlighted red in `diff-overlay.png`, aggregated into **100px-block hotspots** mapped to prototype sections
- **Structural discrepancy report**: missing/extra classes (sorted by frequency), per-property class-style comparison (sampled by frequency, precise to `class → property → prototype value vs restored value`), visible-text multiset diff, interactive-element diff, page-height deviation, broken resource references
- **Determinism**: animations frozen before screenshots (animation paused + transition none) + anti-lazy-loading, so motion timing never produces false differences
- **Zero npm dependencies**: pixel comparison runs inside the browser canvas; no local PNG decoding needed

## Requirements

| Dependency | Requirement | Notes |
|---|---|---|
| Node.js | ≥ 18 (developed on 22.x) | No other npm runtime dependencies |
| playwright-core | ≥ 1.40 (developed on 1.62.1) | Install yourself (see below); never auto-downloaded |
| Browser | Local Chrome or Edge (either) | Tried in order: chrome → msedge → bundled Chromium (browser download only as last resort) |
| OS | Windows / macOS / Linux | Verified on Windows |

## Installation

**Option 1: agent skill installer (recommended)**

```bash
npx skills add clarklee186/html-prototype-reader
```

**Option 2: clone**

```bash
git clone https://github.com/clarklee186/html-prototype-reader.git
```

**Option 3: manual copy** — copy `SKILL.md`, `_meta.json`, and `scripts/` into your agent's skill directory (e.g. WorkBuddy: `~/.workbuddy/skills/html-prototype-reader/`).

Then install the single runtime dependency:

```bash
# Any node_modules location works; scripts resolve in this order:
# ① current NODE_PATH ② ~/.workbuddy/binaries/node/workspace/node_modules ③ sibling node_modules
npm i playwright-core
```

## Usage

### ① Capture a prototype

```bash
node scripts/capture.js <html-file-or-dir> <output-dir> [options]

# Examples
node scripts/capture.js "C:/proto/dashboard.html" "C:/out/prototype"
node scripts/capture.js "C:/proto/pages/" "C:/out/prototype" --viewport 375x812
```

A directory input is processed page by page in filename order (multi-page prototypes). Outputs:

| File | Content |
|---|---|
| `summary.md` | **Read this first**: file composition (markup/CSS/JS bytes + token estimate), screen inventory table, breakpoints, theme states, overlays, broken resources |
| `prototype.json` | Full structured data (schema below) |
| `screen-NN.png` | Per-screen screenshots (visual baseline) |

`prototype.json` component-tree node fields: `t`=tag, `id`, `c`=class array, `r`={x,y,w,h}, `v`=visibility, `rep`=repeated-sibling fold count, `s`=style diff, `ps`=pseudo-elements, `sem`=semantic attributes (role/aria/alt/placeholder/disabled…), `tx`=leaf text, `ch`=children, `img/canvas/iframe`=resource info; page-level keys include `screens[]` (per-screen tree + `interactions` inventory), `overlays[]` (modals/toasts, hidden ones with subtree), `css` (rule stats / breakpoints / `customPropsByState` theme variables / fontFaces), `theme` (toggle probe), `failedRequests`.

### ② Restoration acceptance diff

```bash
node scripts/diff.js <prototype.html|URL> <restored.html|URL> <output-dir> [options]

# A restoration served by a dev server can be compared directly
node scripts/diff.js "C:/proto/dashboard.html" "http://localhost:5173" "C:/out/acceptance"
```

Outputs: `diff-report.md` (**read first**: ratio overview + hotspot table + style-mismatch list), `diff-overlay.png` (differing pixels in red), `prototype.png` / `restored.png`, `diff.json`.

**Interpretation guide**: pixel ratio <1% with no style mismatches → consistent; 1–5% → check whether hotspots concentrate in motion/icons; >5% → fix region by region. The diff compares the **initial render state** of both sides; for multi-screen prototypes restore screen by screen per the capture inventory and run diff per screen.

### ③ As an agent skill

Once installed into an agent's skill directory, it triggers automatically when the user provides an HTML prototype file and asks to "restore / replicate / convert to code / analyze page structure / verify restoration consistency". Standard workflow: `capture.js` to read → agent restores → `diff.js` to verify → fix per discrepancy list → re-run diff until it passes.

## Configuration

### capture.js options

| Option | Default | Description |
|---|---|---|
| `--viewport WxH` | `1440x900` | Render viewport; use `375x812` for mobile restorations |
| `--max-screens N` | `30` | Screen-count cap for traversal, guarding against entry-click loops |
| `--timeout ms` | `45000` | Page load timeout |
| `DEBUG=1` (env) | off | Per-screen capture log (entry hits / click failures / dedup results) — enable when screens go missing |

### diff.js options

| Option | Default | Description |
|---|---|---|
| `--threshold N` | `32` | Pixel-diff threshold (max per-channel delta); raise to tolerate anti-aliasing noise |
| `--block N` | `100` | Hotspot block edge in px; lower for finer localization |
| `--viewport WxH` | `1440x900` | **Both sides must use the same viewport**, otherwise a size mismatch is reported |

### Scenario-based advice

- **Missing screens**: run with `DEBUG=1` to see each entry's click and dedup result; for prototypes with unusual nav structures, extend the entry selectors
- **Many false style differences**: raise `--threshold` (e.g. 48); residual differences in icon/font-rendering areas can usually be ignored
- **Dark/light themes**: capture already outputs `customPropsByState` and the theme probe — implement both sets; run diff separately per theme state
- **Context overflow**: read `summary.md` and screenshots first, drill into `prototype.json` per screen/subtree; never ingest it whole

## Known limitations

- Deep interactions (modal contents, nested tabs, inline expansion states) are only visible after being triggered and cannot be captured otherwise; trigger specific entries manually and re-run capture when needed
- Canvas: only size and position are recorded, bitmap content is not extracted; cross-origin iframes record src only
- Screen deduplication uses a "visible elements + class signature" hash; near-identical screens may merge (bounded by `--max-screens`)

## Regression baseline

On a 783 KB multi-screen dashboard prototype (JS-assembled, dual theme, 45 `@media` blocks): capture produced 8 screens / 908 visible elements / 16 distinct breakpoints / dual-theme probe in 6 s; self-diff ratio was 0 (4 s); an injected color/radius mutation was reported as 4 style mismatches localized to class + property + value (3 s).

## License

[MIT](LICENSE)
