# Copilot / AI Agent Instructions for this repo

## What this repo is

`@jurijsk/codon-format` — Codon's canonical markdown formatter (table alignment, paragraph reflow, layout-only normalization) as a standalone, `vscode`-free library and CLI. It's the exact formatter the `jurijsk.codon` VS Code extension runs on every save; this package lets any Node environment run the same logic (a pre-commit hook, CI, another editor's task runner, a consuming project like `daina6`).

See [README.md](../README.md) for the public API/CLI surface, and [docs/design.md](../docs/design.md) for the *why* behind the table engine, the two width regimes, cross-table matching, and known pitfalls — read it before touching `src/tables.ts` or the passes it coordinates with.

## Per-domain instructions

- [markdown.instructions.md](./instructions/markdown.instructions.md) — **mandatory read before editing any `.md` file in this repo**, including this one. Covers the formatting rule (dogfood with `codon-format` itself, never hand-format) and the target flavor (GFM/CommonMark, no MDC/Comark authored here).

Copilot auto-scopes files under `.github/instructions/` via each file's `applyTo` frontmatter. Agents that don't auto-scope (Claude Code, Cursor, web GitHub, etc.) should follow the link above explicitly whenever the task touches a `.md` file — that's what `CLAUDE.md`'s `@` import at the repo root is for.

## Source layout

The formatter is split by concern under `src/` — `tables.ts`, `frontmatter.ts`, `mdc.ts`, `fences.ts`, `reflow.ts`, `list-tighten.ts`, `eol.ts`, with `markdown-format.ts` as the orchestrator and `format-cli.ts` as the CLI entry point. `docs/design.md`'s file-layout table is the authoritative index — keep it in sync (and each file's own header comment) if you add, remove, or rename a source file.

## After any code change

- `npm run compile` — `out/` is gitignored build output; it must exist and be fresh before running the CLI by hand or the compiled-CLI test suite.
- `npm test` — the full test suite (`vitest run`). A change to `src/tables.ts` or `src/markdown-format.ts` that isn't covered by a new/updated test here is incomplete.
- Version/publish is the user's call — bump `package.json`/`package-lock.json` and update `CHANGELOG.md` when asked, but `npm publish` itself needs the user's own npm auth; don't attempt it.
