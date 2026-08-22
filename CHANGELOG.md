# Changelog

## 0.4.0

- **BREAKING: renamed `formatMarkdownText` → `formatMarkdown` and `FormatMarkdownTextOptions` → `FormatMarkdownOptions`.** No back-compat alias — with only a couple of consumers of this package, the awkward `...Text` suffix wasn't worth carrying forward.
- Added `alignTablesWidth` (default `false`) to `FormatMarkdownOptions`: set it to `true` to have tables with the same structure (exact header match) anywhere in the document share their column widths with each other, instead of each sizing to only its own content. See docs/design.md's "Cross-table width matching" section.
- The CLI gained `--align-tables-width`, the same switch for `codon-format`.

## 0.3.0

- **BREAKING: the package is now ESM-only** (`"type": "module"`). `import { formatMarkdownText } from '@jurijsk/codon-format'` is unchanged and keeps working; a CommonJS `require('@jurijsk/codon-format')` no longer does, except on Node >= 22.12, which supports `require()` of a synchronous ES module. That is a semver-major-flavored change, hence the minor bump on a 0.x line.
- **BREAKING: `engines.node` raised from `>=18` to `>=20.11`** — needed for `import.meta.dirname`. Node 18 has been end-of-life since April 2025.
- Added an `exports` map so the package entry (and its types) resolve through the modern conditional-exports path instead of bare `main`/`types`.
- No formatter behavior changes: the output for any given input is byte-identical to 0.2.3. Internals moved from TypeScript's CommonJS emit to real ES modules (relative imports now carry explicit `.js` extensions, Node builtins use `node:` specifiers), and the CLI/`bin` runs as a module.

## 0.2.3

- Fixed the same dormant-Quarto-cell fence-desync bug from 0.2.2, but in `tables.ts`: `scanTables` kept its own independent fence-toggle (separate from `mdc.ts`'s), which had the identical gap and hid every table for the rest of the file. Same fix, same shape, different file — 0.2.2 only patched `mdc.ts`.
- Consolidated the duplicated fence/comment-tracking logic that caused both bugs: added `src/fences.ts` as the one shared detector, now used by `mdc.ts`, `tables.ts`, and `list-tighten.ts` instead of each keeping its own copy. Also eliminated every hand-typed `` '```' ``/`'<!--'`/`'-->'` string literal across the codebase in favor of named constants in `fences.ts` — the actual root cause was duplicated logic AND duplicated magic strings, not just one bug in one file.

## 0.2.2

- Fixed a bug where a commented-out fenced code cell (`<!-- ```{r} … ``` -->`, a dormant Quarto cell) before an MDC block desynced `mdc.ts`'s fence tracking, silently hiding every MDC block for the rest of the file. MDC detection now skips multi-line HTML comments whole, same as the reflow and list-tighten passes already did.

## 0.2.1

- Renamed `src/listTighten.ts` → `src/list-tighten.ts` (internal only, no functional change — same kebab-case cleanup as 0.2.0's other renames).

## 0.2.0

- Width-0 table padding no longer caps at 80 characters — columns always pad to the widest cell, so pipes stay aligned even with very long cells.
- Renamed `src/formatMdCli.ts` → `src/format-cli.ts` and `src/markdownTextFormat.ts` → `src/markdown-format.ts` (internal; the public import and `codon-format` bin are unaffected).
- Docs: clarified that pre-commit/CI usage relies on the `--width 0` default.

## 0.1.1

- Fixed a raw NUL byte accidentally embedded in table header key generation, which made affected files register as binary to git/grep/etc.

## 0.1.0

- Initial extraction of Codon's markdown formatter as a standalone package.
- Fixed the published bin path (a leading `./` was silently dropped by npm registry validation).
