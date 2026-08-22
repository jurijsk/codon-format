# @jurijsk/codon-format

Codon's canonical markdown formatter — table alignment, paragraph reflow, and layout-only normalization — as a standalone, `vscode`-free library and CLI. This is the exact formatter used by the [Codon](https://github.com/jurijsk/codon) VS Code extension (`jurijsk.codon`) for every save and `Format Document`; this package lets you run the same logic anywhere Node runs — a pre-commit hook, CI, another editor's task runner, or your own scripts.

## What it does

- **Paragraphs and list items** reflow to one line each (indentation preserved).
- **Tables** are rewritten to a canonical GFM shape: pipe-aligned, padded columns, alignment markers (`:--`, `:-:`, `--:`) preserved, ragged rows padded instead of losing cells.
- **Structural content passes through verbatim**: YAML frontmatter, code fences and their bodies, indented code blocks, headings, blockquotes, thematic breaks/setext underlines, HTML blocks and comments, MDC directives (`::name … ::`), link reference definitions, hard-break lines, and Quarto shortcodes (`{{< ... >}}`).
- **Layout-only**: never rewrites inline spelling (emphasis markers, escapes, link encoding, list renumbering).
- **Idempotent**: `format(format(x)) === format(x)`, at every width.

## Install

```
npm install --save-dev @jurijsk/codon-format
```

Requires **Node >= 20.11**. The package is **ESM-only** (`"type": "module"`) — `import` it. A CommonJS `require('@jurijsk/codon-format')` only works on Node >= 22.12, which supports `require()` of a synchronous ES module.

## CLI

```
npx codon-format [<file.md ...>] [--git-driven|--all] [--root <dir>] [--ignore <pattern>]... [--width 0|N>=40] [--check] [--align-tables-width]
```

Exactly one of three things decides *which* files get formatted: explicit file paths, `--git-driven`, or `--all` — passing more than one of the three is an error. With none of the three given, `codon-format` defaults to `--git-driven` from cwd (see the first use case below).

### Use cases

| I want to...                                          | Run                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Format every markdown file in the current project     | `codon-format`                                                                  |
| Format one specific file                              | `codon-format docs/readme.md`                                                   |
| Format several specific files                         | `codon-format docs/a.md docs/b.md`                                              |
| Format everything, ignoring `.gitignore` entirely     | `codon-format --all`                                                            |
| Format a different project without `cd`-ing there     | `codon-format --root ../other-project`                                          |
| Skip a directory `.gitignore` doesn't cover           | `codon-format --ignore fixtures`                                                |
| Check formatting in CI without writing                | `codon-format --check`                                                          |
| Format only files staged for commit (pre-commit hook) | see the [pre-commit example](#example-pre-commit-hook-auto-fix--re-stage) below |

### Parameters

| Flag                   | Default                           | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<file.md ...>`        | —                                 | Explicit file paths. Mutually exclusive with `--git-driven`/`--all`.                                                                                                                                                                                                                                                                                                  |
| `--git-driven`         | on, if nothing else selects files | Delegates to `git ls-files`, respecting `.gitignore`. Outside a git working tree (or without `git` installed), falls back to `--all`'s behavior with a stderr notice instead of erroring.                                                                                                                                                                             |
| `--all`                | off                               | A plain filesystem walk that never touches git and ignores `.gitignore` entirely.                                                                                                                                                                                                                                                                                     |
| `--root <dir>`         | cwd                               | Discovery root for `--git-driven`/`--all`.                                                                                                                                                                                                                                                                                                                            |
| `--ignore <pattern>`   | `[]`                              | Repeatable. Merged with the two always-on defaults (`.git`, `node_modules`), never replacing them.                                                                                                                                                                                                                                                                    |
| `--width 0\|N>=40`     | `0`                               | `0` is the logical/commit form: one pipe-aligned line per table row — **the only width safe to commit**, since every other GFM renderer only understands this form. `N ≥ 40` wraps table cell text onto continuation rows so no table line exceeds N characters, for on-screen/raw-file readability; format back at `--width 0` any time to losslessly collapse them. |
| `--check`              | `false`                           | Reports without writing; exits 1 if any file isn't already canonical at the given width. Pair with the default width for a commit-safety gate in CI.                                                                                                                                                                                                                  |
| `--align-tables-width` | `false`                           | Have tables with the same structure (exact header match) elsewhere in the document share one set of column widths, instead of each sizing to only its own content.                                                                                                                                                                                                    |

Exits 1 on any file read/write error too. Each file keeps its own dominant line-ending style (LF/CRLF preserved, never converted). See [docs/design.md](docs/design.md) and [docs/project-wide-discovery-spec.md](docs/project-wide-discovery-spec.md) for the full discovery design.

### Example: pre-commit hook (auto-fix + re-stage)

Explicit file paths, not `--git-driven`/`--all`, since only the staged subset should be touched:

```bash
#!/usr/bin/env sh
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md')
[ -z "$files" ] && exit 0
npx codon-format $files
git add $files
```

### Example: CI gate

```bash
npx codon-format --check
```

## Library

```ts
import { formatMarkdown } from '@jurijsk/codon-format';

const formatted = formatMarkdown(sourceText, { tableWidth: 0 });
```

`formatMarkdown(content: string, options?: { tableWidth?: number; alignTablesWidth?: boolean }): string` — pure string→string, preserves the input's dominant EOL. `tableWidth` defaults to `0`. `alignTablesWidth` defaults to `false` — every table sizes to only its own content; set it to `true` to have tables sharing an exact header elsewhere in the document share one set of column widths instead.

```ts
import { discoverMarkdownFiles } from '@jurijsk/codon-format';

const files = discoverMarkdownFiles({ root: '.', mode: 'git-driven' });
// -> ['README.md', 'docs/design.md', ...] — root-relative paths, no formatting side effects
```

`discoverMarkdownFiles(options?: { root?: string; mode?: 'git-driven' | 'all'; ignore?: string[] }): string[]` — the same discovery the CLI's `--git-driven`/`--all` use, as a plain function: paths only, so a caller can inspect or discard some of them before formatting the rest (`formatMarkdown` on each path is left entirely to the caller). `mode` defaults to `'git-driven'`, including its fallback-to-`'all'` behavior outside a git working tree.

## Relationship to the Codon VS Code extension

[Codon](https://github.com/jurijsk/codon) depends on this package and runs the exact same `formatMarkdown` for `Format Document`, `editor.formatOnSave`, and every save made through its WYSIWYG preview — so whatever this CLI produces is exactly what the editor would have written.

## Development

The source is split by concern (`src/tables.ts`, `src/frontmatter.ts`, `src/mdc.ts`, `src/fences.ts`, `src/reflow.ts`, `src/list-tighten.ts`, `src/eol.ts`, `src/discover.ts`, with `src/markdown-format.ts` as the orchestrator) — see [docs/design.md](docs/design.md) for the full writeup: the *why* behind the table engine's width regimes, cross-table matching, the CLI's `--check` semantics, project-wide discovery, and known pitfalls.

## License

MIT
