# AGENTS.md

Guidance for AI coding agents (and human contributors) working **on this repository** — i.e. modifying, extending, or regressing `html-prototype-reader` itself. If you are an agent *using* the installed skill to read prototypes and restore code, read `SKILL.md` instead; this file is for development work.

**For Claude Code:** this file is the single source of development guidance. `CLAUDE.md` imports it — do not duplicate content there.

## What this repository is

An agent skill with two Node CLI tools built on `playwright-core`:

- `scripts/capture.js` — renders an HTML prototype (file:// or URL, single- or multi-page) in headless Chrome/Edge, walks it interactively (clicks nav/tab entries, dedupes screens by visible-element signature), and emits structured facts: `prototype.json` (component tree with computed styles diffed against parents, pseudo-elements, interactive inventory, breakpoints, theme probe, overlays, broken resources) + `summary.md` + per-screen screenshots.
- `scripts/diff.js` — acceptance comparison between a prototype and a restoration: same-viewport fullPage screenshots, per-pixel threshold comparison performed inside the browser canvas (zero npm deps; no local PNG decoding), plus a structural/style/interaction discrepancy report with block hotspots mapped to prototype sections.

Repo layout:

```
SKILL.md          # agent-facing skill doc (trigger conditions, usage, output schema, boundaries, maintenance log)
_meta.json        # registry metadata — description MUST stay byte-identical to SKILL.md frontmatter description; version is semver and MUST equal package.json version
package.json      # engines.node >= 18, capture/diff shortcuts, npm test
LICENSE           # MIT
scripts/shared.js      # single source of truth: STYLE_PROPS, ALWAYS_KEEP, DIFF_PROPS, FREEZE_CSS, LAUNCH_ARGS, IFRAME_DEPTH_LIMIT, SCHEMA_VERSION, TUNING
scripts/inpage-lib.js  # in-page library (serialised into the page via toString + %PLACEHOLDER% substitution) — separate file so it can be syntax-checked
scripts/capture.js     # render + traverse + compress + output (Node side)
scripts/diff.js        # acceptance diff (pixel + structural)
scripts/check-meta.js  # _meta.json ↔ package.json ↔ SKILL.md consistency (run by npm test)
scripts/check-docs.js  # README/docs parity, image language match, CLI-default coverage (run by npm test)
test/run-tests.js      # npm test: component matrix + acceptance chain + repo consistency
test/fixtures/         # component coverage fixture (24 assertions depend on it)
.github/workflows/test.yml  # CI: ubuntu + windows, installs Chromium, runs npm test
README.md / README.zh-CN.md   # English / Chinese entrance pages, kept in structural parity
assets/                # README visuals (banner.webp, features.webp EN, features.zh-CN.webp ZH)
docs/                  # detail that does not belong in the README entrance: CLI reference, output schema (EN + zh-CN)
AGENTS.md / CLAUDE.md         # this file and its importer
```

## Environment

- Node ≥ 18 (developed on 22.x). The only runtime dependency is `playwright-core` (≥ 1.40, developed on 1.62.1), declared as an optional peer dependency in `package.json`.
- Scripts resolve `playwright-core` in this order: current `NODE_PATH` → `~/.workbuddy/binaries/node/workspace/node_modules` (derived from `os.homedir()`) → `../node_modules` → `node_modules` under cwd. Never hardcode a user-specific absolute path here; never commit `node_modules`.
- Browser: local Chrome → Edge → bundled Chromium (last resort). Both scripts launch with `LAUNCH_ARGS` (`--allow-file-access-from-files`) — required for canvas reads of `file://` images (diff) **and** for same-origin iframe recursion (capture).
- Regression is `npm i && npm test` (see "Regression" below); the in-page library is syntax-checked separately from the host script.

## Hard-won invariants (break these and things fail silently)

These were learned by debugging; each is load-bearing. If you touch the relevant code, re-verify the invariant.

1. **Re-query element handles every traversal iteration.** Clicking a nav entry in dynamic prototypes rebuilds the whole DOM; handles captured upfront die with "Element is not attached to the DOM" and most screens are silently skipped. `capture.js` re-runs `page.$$` inside the loop — keep it that way.
2. **Pseudo-element filter must not exclude empty content.** Decorative layers are `content:''` + `position:absolute`. Filter on `content !== 'none'/'normal'` and record `position`; do not filter on content being non-empty.
3. **Strip `px` before numeric breakpoint parsing** (`parseFloat`), otherwise the breakpoint list is all `NaN`.
4. **Playwright `evaluate` with a *string* that looks like a function is evaluated as an expression.** An arrow function with a destructured object parameter serializes to `undefined`. `diff.js`'s `COMPARE_FN` must stay a real function object passed directly. If you add injected constants, follow `capture.js`'s `%PLACEHOLDER%`-string replacement pattern instead (placeholders must live inside string literals so the file still parses).
5. **Screenshot determinism requires the shared freeze, on both sides.** `FREEZE_CSS` from `shared.js` is injected into both the prototype and the restoration before screenshots, and into capture before screen traversal. It uses `transition-duration: 0.001s` rather than `transition:none` on purpose: still deterministic, but `transitionend` still fires, so prototypes that reveal content on `transitionend` keep working.
6. **The in-page library lives in `scripts/inpage-lib.js` and is injected via `Function.prototype.toString`** with `%STYLE_PROPS_JSON%` / `%ALWAYS_KEEP_JSON%` / `%IFRAME_DEPTH%` / `%TUNING_JSON%` replaced at runtime (separate file so `node --check` and reviewers can see it); `diff.js` does the same with `%DIFF_PROPS%` inside `SNAPSHOT_FN`. Placeholders must live inside string literals so the file still parses. **Style-property lists live only in `shared.js`**: `STYLE_PROPS` is the full capture list, `DIFF_PROPS` is the deliberately smaller high-signal subset used for acceptance (it excludes `transform` / `transition` / `opacity`, which legitimately differ between implementations and would drown real mismatches in noise). Editing an in-page list instead of `shared.js` does nothing.
7. **Output paths must be absolute** in `diff.js` (`OUT = path.resolve(outDir)`); relative output dirs break the `file://` image URLs passed to the compare page.
8. **`_meta.json` description must be byte-identical to the SKILL.md frontmatter description, and `version` must match both `package.json` and the semver you publish with.** Registries reject mismatches. Bump on every published change.

9. **Widget state is read as DOM properties, never attributes.** JS-set state (`el.checked = true`, `el.value = '…'`, `dialog.open = true`) does not update the corresponding attribute, so attribute-only reading silently misses it — this caused a 17-point coverage gap (7/24 → 24/24 on the component matrix, v1.0.5). `semOf` reads `checked` / `indeterminate` / `value` / `selected` / `open` / `multiple` as properties, plus the aria-state attributes (`aria-checked` / `aria-selected` / `aria-expanded` / `aria-pressed` / `aria-valuenow`…). When adding new state reads, decide explicitly: property for state, attribute for markup.
10. **Off-canvas detection uses document flow bounds, not the viewport.** `offViewport` compares absolute page coordinates against `documentElement.clientWidth` / `scrollHeight`; a viewport-relative check would flag every below-the-fold element on tall pages.
11. **`String.prototype.replace` eats `$$`.** When patching files with a script, `str.replace(a, b)` treats `$$` in `b` as an escaped `$` — a Playwright `page.$$(sel)` in a patch string silently became `page.$(sel)` (single element) and made every entry lookup fail while reporting zero errors. Use `split().join()` for patch replacements, and after patching always re-read the touched lines.
12. **In-page `page.evaluate` callbacks cannot see Node-side constants.** Only the injected `inpage-lib.js` gets `TUNING` (via `%TUNING_JSON%`). Passing `TUNING.foo` inside a Node-side `page.evaluate(() => …)` throws `ReferenceError` at runtime; pass values as the second argument instead: `page.evaluate(({step}) => …, {step: TUNING.scrollStepPx})`.
13. **The in-page library is injected once per page (`window.__hprLib`) and re-injected on demand.** Entry clicks can trigger real navigations; `ensureLib` + `callLib` re-inject when the global is gone. Do not go back to concatenating `libSrc` into every `evaluate` — that re-parsed ~16 KB per call, 7 times per screen.
14. **Failure must be loud.** Structurally: `warnings[]` on both artifacts, `schemaVersion` for consumers, `structureOk` / `pixel: null` instead of zeros, and exit code 2 when a dimension was not measured. A silent zero is worse than a crash in an acceptance tool.

## Regression

`npm i && npm test` is the whole regression: component matrix (24 state assertions on `test/fixtures/components.html`), acceptance chain (self-diff must be ratio 0, a mutated copy must be detected, a missing restored file must exit 2 with `structure: null`, a tall page must be truncated + warned), and repo consistency (`check-meta` + `check-docs`). CI runs it on ubuntu and windows.

For behaviour changes also run capture against a real multi-screen JS-assembled prototype (dark/light themes, many `@media` blocks). Documented baseline on one such file:

- `capture.js`: 8 screens (initial + 7 nav), 908 visible elements, 16 distinct breakpoints, theme probe detected, 6–7 s, 0 warnings
- `deadContent` on the same file: 1,092 statically-checkable CSS rules → 69 matched, 20 dormant (active states), 1,003 not seen during capture
- `diff.js` self-comparison: pixel ratio 0, all structural diffs 0, ~3–4 s
- `diff.js` against an intentionally mutated copy (main colour + radius variables changed): exactly the injected mismatches localised to class + property + value

A mutated fixture lives outside this repo (workbench `poc-html-reader/mutant/`); `test/run-tests.js` generates its own mutant from the component fixture.

## Conventions

- Commits: conventional commits (`feat:`, `fix:` …), no backticks in messages. Default branch `main`, LF line endings enforced by `.gitattributes`.
- Version bumps: update `version` in **both** `_meta.json` and `package.json`; if the description changed, update it in **both** `_meta.json` and the `SKILL.md` frontmatter, word for word.
- Document every non-obvious fix in the `SKILL.md` "维护记录" (maintenance log) section — that log is how future agents avoid rediscovering the pitfalls above.
- User-facing docs (`README.md` / `README.zh-CN.md`) are maintained in parallel; structural parity is required (same section count, same code blocks), language differs. They follow the portfolio-README structure produced with the `readme-generator` skill: centred header + banner, ≤3 badges, then What / Why / You get / How it works / Quick start / Install / CLI / Limits / Proof / License / Author. Keep depth out of the README — option tables and output schemas live in `docs/`, linked from the CLI section.
- README visuals are generated from the `readme-generator` skill's HTML templates (`assets/banner.webp`, `assets/features.webp`) with the project's own story; regenerate them if the positioning changes, and keep all in-image text ≥22px (body copy ≥28px) since GitHub scales images down.
- Do not add npm runtime dependencies. The zero-dependency design (in-browser canvas pixel comparison) is intentional.
