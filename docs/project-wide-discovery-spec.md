---
status: implemented (src/discover.ts)
---

# Project-wide file discovery for `codon-format`

## Problem

`codon-format` only operates on the file paths it's handed on the command line — it has no include/ignore config of its own. A caller that wants "format every markdown file in this project" has to enumerate them itself, and without git-aware logic that enumeration either drifts from `.gitignore` or hand-rolls its own exclude list.

## Design

Exactly one of three things decides which files get formatted: explicit file paths, `--git-driven`, or `--all` — passing more than one of the three is an error, since "format exactly these" and "find them yourself" isn't a coherent combined request. With none of the three given, the CLI defaults to `--git-driven` from cwd rather than erroring.

- **`--git-driven`** — every file that would be part of the repo if `git add -A` ran right now: every tracked file, plus every untracked file that isn't gitignored. Requires a git working tree; outside one — or if `git` isn't installed — it falls back to `--all`'s behavior instead of erroring, printing a non-fatal stderr notice. This matters because `codon-format` also runs as a library or editor plugin (`jurijsk.codon` runs it on every save), and that caller can't always guarantee it's pointed at a git workspace.
- **`--all`** — a plain recursive filesystem walk. Never touches git, ignores `.gitignore` entirely.

There's no staged-files-only mode (`git diff --cached`, for a pre-commit hook): pass the staged files as explicit arguments instead — see the "Use cases" table.

## Use cases

| I want to...                                          | Run                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Format every markdown file in the current project     | `codon-format`                                                                                |
| Format one specific file                              | `codon-format docs/readme.md`                                                                 |
| Format several specific files                         | `codon-format docs/a.md docs/b.md`                                                            |
| Format everything, ignoring `.gitignore` entirely     | `codon-format --all`                                                                          |
| Format a different project without `cd`-ing there     | `codon-format --root ../other-project`                                                        |
| Skip a directory `.gitignore` doesn't cover           | `codon-format --ignore fixtures`                                                              |
| Check formatting in CI without writing                | `codon-format --check`                                                                        |
| Format only files staged for commit (pre-commit hook) | `` files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md'); codon-format $files `` |

## CLI parameters

| Flag                 | Default                           | Notes                                                                                                                                                    |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<file.md ...>`      | —                                 | Explicit file paths. Mutually exclusive with `--git-driven`/`--all`.                                                                                     |
| `--git-driven`       | on, if nothing else selects files | Delegates to `git ls-files`, respecting `.gitignore`. Falls back to `--all`'s behavior with a stderr notice outside a git working tree or without `git`. |
| `--all`              | off                               | A plain filesystem walk that never touches git and ignores `.gitignore` entirely.                                                                        |
| `--root <dir>`       | cwd                               | Discovery root for `--git-driven`/`--all`.                                                                                                               |
| `--ignore <pattern>` | `[]`                              | Repeatable. Merged with the two always-on defaults (`.git`, `node_modules`), never replacing them.                                                       |

## Implementation

**`--git-driven`** shells out to:

```
git -C <root> ls-files -z --cached --others --exclude-standard \
  -- '*.md' '*.mdc' '*.qmd' [':!'+pattern for each --ignore value]
```

- No `--full-name`: that flag reports paths relative to the repository's top level rather than to `--root`, which is wrong whenever `--root` is a subdirectory of a larger repo. `-C <root>` alone already makes git treat `--root` as its effective cwd, giving root-relative paths with no extra flag.
- `-z` NUL-separates output so filenames containing spaces or non-ASCII characters survive intact.
- Each `--ignore` value becomes a `:!<pattern>` pathspec argument rather than git's `--exclude=<pattern>` flag — `--exclude=` only filters `--others` (untracked) output, not `--cached` (tracked), so a tracked file matching the pattern would silently survive.
- Falls back to `--all`'s plain walk on ANY failure to get a usable listing — not a git working tree, or `git` isn't installed — since there's nothing to distinguish between those two cases for this purpose.

**`--all`** is a plain recursive walk, matching `--ignore` patterns with a simple, hand-rolled matcher (`matchesIgnore` in `src/discover.ts`) — no gitignore dialect, no glob wildcards, no negation, no nested-file lookups:

- A pattern with no `/` matches if any path segment equals it exactly (an unanchored directory/file-name exclusion — `output`, `tmp`, `node_modules`).
- A pattern with a `/` matches if the path, or any suffix of the path starting at a segment boundary, equals the pattern or continues past it at another segment boundary (a multi-segment prefix exclusion — `.meta/debug` matches `.meta/debug/x.md` but not `.meta/debugger/x.md`).
- A single trailing `/` on a pattern is stripped first.

`.git` matters most for this matcher: the plain walk has nothing else stopping it from wastefully descending into `.git/objects/`, `.git/logs/`, etc. if `--root` happens to be an actual repo. (`--git-driven`'s own `git ls-files` would never surface `.git/` paths regardless of any ignore pattern, so the same default entry is a harmless no-op there — kept anyway so there's one uniform default list instead of two.)

## Programmatic API

```ts
export interface DiscoverMarkdownFilesOptions {
	root?: string; // default: cwd
	mode?: 'git-driven' | 'all'; // default: 'git-driven'
	ignore?: string[];
}

export function discoverMarkdownFiles(options?: DiscoverMarkdownFilesOptions): string[]
```

Exported alongside `formatMarkdown`. Returns paths only — root-relative, forward-slash-normalized — with no read/write/format side effects and no bundled formatting option: a caller that wants to inspect or discard some of the discovered files before formatting the rest needs that separation. `mode` defaults to `'git-driven'`, including its fallback-to-`'all'` behavior outside a git working tree. Unlike the CLI, there's no zero-argument default here to trigger — this is a plain function, called only when a caller asks for it.

## Interaction with explicit file arguments

`codon-format <file.md ...>` is unaffected — `--git-driven`/`--all` are additional, mutually exclusive modes, not a replacement.
