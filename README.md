# @jurijsk/codon-format

Codon's canonical markdown formatter — table alignment, paragraph reflow, and layout-only
normalization — as a standalone, `vscode`-free library and CLI. This is the exact formatter used
by the [Codon](https://github.com/jurijsk/codon) VS Code extension (`jurijsk.codon`) for every
save and `Format Document`; this package lets you run the same logic anywhere Node runs — a
pre-commit hook, CI, another editor's task runner, or your own scripts.

## What it does

- **Paragraphs and list items** reflow to one line each (indentation preserved).
- **Tables** are rewritten to a canonical GFM shape: pipe-aligned, padded columns, alignment
  markers (`:--`, `:-:`, `--:`) preserved, ragged rows padded instead of losing cells.
- **Structural content passes through verbatim**: YAML frontmatter, code fences and their bodies,
  indented code blocks, headings, blockquotes, thematic breaks/setext underlines, HTML blocks and
  comments, MDC directives (`::name … ::`), link reference definitions, hard-break lines, and
  Quarto shortcodes (`{{< ... >}}`).
- **Layout-only**: never rewrites inline spelling (emphasis markers, escapes, link encoding, list
  renumbering).
- **Idempotent**: `format(format(x)) === format(x)`, at every width.

## Install

```
npm install --save-dev @jurijsk/codon-format
```

## CLI

```
npx codon-format <file.md ...> [--width 0|N>=40] [--check]
```

- **`--width 0`** (the default) — the logical/commit form: one pipe-aligned line per table row.
  **This is the only width safe to commit** — every other GFM renderer (GitHub included) only
  understands this form. Anything wider uses a raw-file-only continuation-row convention that only
  Codon's own reader collapses back losslessly; other renderers show it as broken, mostly-empty
  extra rows.
- **`--width N`** (N ≥ 40) — wraps table cell text at whitespace onto continuation rows so no
  table line exceeds N characters. Useful for on-screen/raw-file readability while editing; format
  back at `--width 0` any time to losslessly collapse continuation rows to their logical form.
- **`--check`** — reports without writing; exits 1 if any file isn't already canonical at the
  given width, 0 if every file is clean. A general "is this file formatted (at this width)" gate —
  pair it with `--width 0` (or omit `--width`) for a **commit-safety** gate in CI. A **local**
  pre-commit hook more often wants the default write mode instead (rewrite + re-stage, the way
  `prettier --write` works under lint-staged) rather than failing the commit outright.

Exits 1 on any file read/write error too. Each file keeps its own dominant line-ending style
(LF/CRLF preserved, never converted).

### Example: pre-commit hook (auto-fix + re-stage)

No `--width` flag below — it defaults to `0`, the only width safe to commit:

```bash
#!/usr/bin/env sh
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md')
[ -z "$files" ] && exit 0
npx codon-format $files
git add $files
```

### Example: CI gate

Again, no `--width` flag — `--check` alone gates on the default (`0`):

```bash
npx codon-format $(git ls-files '*.md') --check
```

## Library

```ts
import { formatMarkdownText } from '@jurijsk/codon-format';

const formatted = formatMarkdownText(sourceText, { tableWidth: 0 });
```

`formatMarkdownText(content: string, options?: { tableWidth?: number }): string` — pure
string→string, preserves the input's dominant EOL. `tableWidth` defaults to `0`.

## Relationship to the Codon VS Code extension

[Codon](https://github.com/jurijsk/codon) depends on this package and runs the exact same
`formatMarkdownText` for `Format Document`, `editor.formatOnSave`, and every save made through its
WYSIWYG preview — so whatever this CLI produces is exactly what the editor would have written.

## Development

The source is split by concern (`src/tables.ts`, `src/frontmatter.ts`, `src/mdc.ts`,
`src/reflow.ts`, `src/list-tighten.ts`, `src/eol.ts`, with `src/markdown-format.ts` as the
orchestrator) — see [docs/design.md](docs/design.md) for the full writeup: the *why* behind the
table engine's width regimes, cross-table matching, the CLI's `--check` semantics, and known
pitfalls.

## License

MIT
