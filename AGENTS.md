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
_meta.json        # registry metadata — description MUST stay byte-identical to SKILL.md frontmatter description; version is semver
package.json      # version must match _meta.json; declares engines.node >= 18 and capture/diff shortcuts
LICENSE           # MIT
scripts/shared.js     # single source of truth: STYLE_PROPS, ALWAYS_KEEP, DIFF_PROPS, FREEZE_CSS, LAUNCH_ARGS, IFRAME_DEPTH_LIMIT
scripts/capture.js    # render + traverse + compress + output
scripts/diff.js       # acceptance diff (pixel + structural)
README.md / README.zh-CN.md   # English / Chinese, kept in structural parity (9 sections, same code blocks and tables)
AGENTS.md / CLAUDE.md         # this file and its importer
```

## Environment

- Node ≥ 18 (developed on 22.x). The only runtime dependency is `playwright-core` (≥ 1.40, developed on 1.62.1), declared as an optional peer dependency in `package.json`.
- Scripts resolve `playwright-core` in this order: current `NODE_PATH` → `~/.workbuddy/binaries/node/workspace/node_modules` (derived from `os.homedir()`) → `../node_modules` → `node_modules` under cwd. Never hardcode a user-specific absolute path here; never commit `node_modules`.
- Browser: local Chrome → Edge → bundled Chromium (last resort). Both scripts launch with `LAUNCH_ARGS` (`--allow-file-access-from-files`) — required for canvas reads of `file://` images (diff) **and** for same-origin iframe recursion (capture).
- No test suite exists. Regression is a documented baseline (see "Regression" below).

## Hard-won invariants (break these and things fail silently)

These were learned by debugging; each is load-bearing. If you touch the relevant code, re-verify the invariant.

1. **Re-query element handles every traversal iteration.** Clicking a nav entry in dynamic prototypes rebuilds the whole DOM; handles captured upfront die with "Element is not attached to the DOM" and most screens are silently skipped. `capture.js` re-runs `page.$$` inside the loop — keep it that way.
2. **Pseudo-element filter must not exclude empty content.** Decorative layers are `content:''` + `position:absolute`. Filter on `content !== 'none'/'normal'` and record `position`; do not filter on content being non-empty.
3. **Strip `px` before numeric breakpoint parsing** (`parseFloat`), otherwise the breakpoint list is all `NaN`.
4. **Playwright `evaluate` with a *string* that looks like a function is evaluated as an expression.** An arrow function with a destructured object parameter serializes to `undefined`. `diff.js`'s `COMPARE_FN` must stay a real function object passed directly. If you add injected constants, follow `capture.js`'s `%PLACEHOLDER%`-string replacement pattern instead (placeholders must live inside string literals so the file still parses).
5. **Screenshot determinism requires the shared freeze, on both sides.** `FREEZE_CSS` from `shared.js` is injected into both the prototype and the restoration before screenshots, and into capture before screen traversal. It uses `transition-duration: 0.001s` rather than `transition:none` on purpose: still deterministic, but `transitionend` still fires, so prototypes that reveal content on `transitionend` keep working.
6. **`capture.js` injects `inPageLib` via `Function.prototype.toString`** with `%STYLE_PROPS_JSON%` / `%ALWAYS_KEEP_JSON%` / `%IFRAME_DEPTH%` replaced at runtime; `diff.js` does the same with `%DIFF_PROPS%` inside `SNAPSHOT_FN`. Placeholders must live inside string literals so the file still parses. **Style-property lists live only in `shared.js`**: `STYLE_PROPS` is the full capture list, `DIFF_PROPS` is the deliberately smaller high-signal subset used for acceptance (it excludes `transform` / `transition` / `opacity`, which legitimately differ between implementations and would drown real mismatches in noise). Editing an in-page list instead of `shared.js` does nothing.
7. **Output paths must be absolute** in `diff.js` (`OUT = path.resolve(outDir)`); relative output dirs break the `file://` image URLs passed to the compare page.
8. **`_meta.json` description must be byte-identical to the SKILL.md frontmatter description, and `version` must match both `package.json` and the semver you publish with.** Registries reject mismatches. Bump on every published change.

## Regression baseline

No unit tests. Validate changes against a real multi-screen JS-assembled prototype (dark/light themes, many `@media` blocks). Documented baseline on one such file:

- `capture.js`: 8 screens (initial + 7 nav), 908 visible elements, 16 distinct breakpoints, theme toggle detected, ~6 s
- `diff.js` self-comparison: pixel ratio 0, all structural diffs 0, ~4 s
- `diff.js` against an intentionally mutated copy (main color + radius variables changed): exactly the injected mismatches localized to class + property + value, ~3 s

A mutated fixture lives outside this repo (workbench `poc-html-reader/mutant/`); recreate one by string-replacing two CSS custom property values in any prototype.

After any behavior change: re-run capture on the reference prototype and confirm screen count, breakpoint list, and theme probe are unchanged unless the change was intended to alter them.

## Conventions

- Commits: conventional commits (`feat:`, `fix:` …), no backticks in messages. Default branch `main`, LF line endings enforced by `.gitattributes`.
- Version bumps: update `version` in **both** `_meta.json` and `package.json`; if the description changed, update it in **both** `_meta.json` and the `SKILL.md` frontmatter, word for word.
- Document every non-obvious fix in the `SKILL.md` "维护记录" (maintenance log) section — that log is how future agents avoid rediscovering the pitfalls above.
- User-facing docs (`README.md` / `README.zh-CN.md`) are maintained in parallel; structural parity is required (same section count, same code blocks and tables), language differs.
- Do not add npm runtime dependencies. The zero-dependency design (in-browser canvas pixel comparison) is intentional.
