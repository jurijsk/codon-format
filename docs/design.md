# How the formatter works, and why

This is the design writeup behind the formatter's source — the *what* lives in each file's own header comment (kept in sync with this doc); this covers the *why*, the internals worth knowing before touching the table engine, and pitfalls that already bit us once.

## File layout

The formatter is split by concern, not left as one large file — the file you want is usually the answer to "where does X happen":

| File                 | Answers                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown-format.ts` | The orchestrator — `formatMarkdown`/`tablesToLogicalRows`, wiring the passes below into the one function Codon and the CLI call. Read this file first; it's the pipeline's shape, not its internals. |
| `frontmatter.ts`     | Where do we detect YAML frontmatter?                                                                                                                                                                 |
| `mdc.ts`             | Where do we detect MDC block components (`::name … ::`)?                                                                                                                                             |
| `fences.ts`          | Where do we detect fenced code blocks and multi-line HTML comments — the shared fence-toggle mdc.ts, tables.ts, and list-tighten.ts all key off, instead of each keeping its own copy?               |
| `reflow.ts`          | Where do we join wrapped paragraphs/list items onto one line?                                                                                                                                        |
| `list-tighten.ts`    | Where do we drop blank lines between simple list items?                                                                                                                                              |
| `tables.ts`          | Where do we format tables — parsing, column widths, wrapping, cross-table matching, emission?                                                                                                        |
| `eol.ts`             | Where do we detect/normalize line endings?                                                                                                                                                           |
| `discover.ts`        | Where do we find project-wide markdown files (`discoverMarkdownFiles`, the CLI's `--git-driven`/`--all`)?                                                                                            |

`frontmatter.ts`, `mdc.ts`, and `fences.ts` exist for **detection only** — `reflow.ts`, `list-tighten.ts`, and `tables.ts` each call into them to find out which lines to leave completely alone, rather than duplicating that detection logic. `fences.ts` is the newest of the three (see the pitfall below for why it had to stop being duplicated).

## The contract, restated

- **Idempotent** at every width: `format(format(x)) === format(x)`.
- **Pipeline-stable**: `format(serialize(parse(format(x)))) === format(x)` — one save cycle of already-formatted text changes nothing. This half of the contract can only be verified against a real markdown-editing pipeline (parse → edit → serialize), which needs a DOM (jsdom) — this package deliberately doesn't have one, so that half is pinned in the **consumer** repo instead: [jurijsk/codon](https://github.com/jurijsk/codon)'s `test/formatParity.test.ts`, which imports this package and drives it against Codon's real TipTap/ProseMirror pipeline. If you change table/paragraph layout here, that test is the one that actually proves you haven't broken the editor round-trip — running only this package's own test suite isn't sufficient.
- **Layout-only**: never touches inline spelling (emphasis markers, escape sequences, link encoding, list renumbering). A formatter that also normalized `*x*` → `_x_` would be a different, riskier kind of tool — this one only ever moves whitespace and line breaks.

## The table engine

### Two width regimes, not a spectrum

`tableWidth` is not "pick any wrap column" — it's binary in shape:

- **`0`** — every logical row becomes exactly one raw-file line, padded so pipes align down the page. This is the **logical / commit form**: the byte-for-byte layout every other GFM renderer (GitHub, GitLab, whatever) understands correctly.
- **`N` where `N ≥ 40`** — cell text wraps at whitespace onto **continuation rows**: a raw-file-only row whose first cell is empty and whose other cells carry the wrapped tail of the row above. This is a convention *this formatter itself* invented for on-disk readability of wide tables — no other markdown tool recognizes it. `collapseContinuationRows` is the inverse: it runs before any other table work, so a file written at any width normalizes losslessly back to logical rows at width 0. **This is why 0 is the only commit-safe width** (see the CLI section below) — continuation rows outside this formatter's own reader render as extra, mostly-empty broken rows.
- Values `1–39` clamp up to 40 (`MIN_TABLE_WIDTH`) — below that the shrink-to-fit loop can't do anything useful with real cell content.

### Width-0 padding has no cap — alignment always wins

At width 0, columns pad to their widest cell, uncapped. An earlier version capped padding at 80 chars (`MAX_PAD_WIDTH`) so a monster cell (a key-value dump running to thousands of characters, which real fixtures in Codon's `examples/` corpus actually contain) wouldn't force every *other* row in that column to pad out to match it — past the cap, the monster cell kept its full content and simply overflowed its own column, alignment giving up before content did. That traded away the one thing width-0 exists to guarantee: every row's pipes actually line up. The cap is gone now — a genuinely huge cell inflates its column's padding for every row, which is the correct trade for a regime whose entire purpose is visual alignment. Content is still never truncated.

### The shrink-to-fit loop (width N)

`computeColumnWidths` starts every column at its natural (longest-cell) width, then — only when fitting to a target `maxLineLength` — repeatedly shrinks the currently-widest column by one character until the total line length fits or every column has hit its **floor**. A column's floor is the longer of: its header cell (a GFM header can't wrap; the delimiter row must sit on the very next line) and the longest whitespace-unbreakable token in any body cell. If the floors alone don't fit the target, the table settles at the minimal width *above* the target that keeps every word whole — wider than asked, never with a word sliced (a sliced `idempo`/`tent` would round-trip back together as `idempo tent`, corrupting content).

### Cross-table width matching

Opt-in via `formatMarkdown`'s `alignTablesWidth` option (default `false`; the CLI exposes the same switch as `--align-tables-width`, see below). When set, tables with an **exact header match** — same cell text, same column count, same order, anywhere in the same document — share one set of column widths, computed as if all their rows (one shared header + every table's body rows, concatenated) were a single table. Implementation: `scanTables`/`emitTableLines` split table-block *discovery* from *emission* specifically so `formatMarkdown` can group same-header tables and pre-compute shared widths before any of them render when the option is on — a table's own width is otherwise always computed standalone (`computeColumnWidths` on just its own rows). The option only gates the grouping step in `formatMarkdown` itself — `scanTables`/`emitTableLines`/`tableHeaderKey` are unconditional; a caller computing widths directly from `tables.ts` always gets standalone widths unless it does the grouping itself.

This exists because a document with several tables sharing a schema (one per section — a repo inventory, a per-environment config table, whatever) reads far better with visually consistent columns than with each table independently squeezed to its own narrowest content. Matching is **exact text**, not fuzzy/order-insensitive — two tables with the same labels in a different order are treated as different schemas on purpose; silently re-mapping columns by label would be a much riskier, harder-to-predict transform for comparatively little benefit.

## The CLI (`codon-format`)

### `--check` is a general gate, not a commit-only one

`--check --width N` validates against whatever width you asked for — it does **not** silently coerce to 0. Early on this package briefly *rejected* `--check` combined with a nonzero `--width`, on the theory that `--check`'s only legitimate use was "is this safe to commit" (which is always width 0). That was reverted: it's the caller's call whether they want to gate on some other width (testing, debugging, a downstream project with its own on-disk convention) — the CLI trusts the caller rather than enforcing one opinion about what `--check` is for. What's true regardless: **only width 0 is safe to commit** (see above) — that's documentation/guidance, not something the tool polices.

### Auto-fix vs. gate — pick the one that matches where you're calling it from

- **CI** (a PR check that shouldn't silently mutate the branch): `codon-format $(git ls-files '*.md') --check`.
- **Local pre-commit hook** (friendlier — let it fix and continue, the way `prettier --write` does under lint-staged):
  ```bash
  files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md')
  [ -z "$files" ] && exit 0
  npx codon-format $files
  git add $files
  ```
  `--check` in a *local* hook just means "fail the commit and make the human re-run the formatter themselves" — usually not what you want for pure formatting.

### Project-wide discovery: `--git-driven`/`--all`

Two mutually exclusive flags trigger discovery instead of formatting the positional file arguments: `--git-driven` (delegates to `git ls-files`, so it respects `.gitignore`; falls back to `--all`'s behavior, with a stderr notice, when `--root` isn't a git working tree or `git` isn't installed) and `--all` (an explicit opt-in plain filesystem walk that never touches git and ignores `.gitignore` entirely). `--root <dir>` sets the discovery root (default cwd); `--ignore <pattern>` (repeatable) adds exclusions on top of the two defaults (`.git`, `node_modules`), which are always merged in and can never be removed. With no file arguments and neither discovery flag, the CLI defaults to `--git-driven` from cwd rather than erroring. The same discovery is exposed programmatically as `discoverMarkdownFiles` (paths only, no bundled formatting) for a consumer like `jurijsk/codon` that imports the formatter directly rather than shelling out to the CLI.

Implementation lives in `discover.ts`; the full design writeup is in [docs/project-wide-discovery-spec.md](./project-wide-discovery-spec.md).

## Known pitfall: watch for control bytes silently introduced by editing tools

`tableHeaderKey`'s join separator was briefly a **raw NUL byte (U+0000)** instead of the literal text `.join(' ')` — an editing-tool artifact, not a deliberate choice. It didn't break anything at *runtime* — JS strings permit embedded NUL bytes — but it made the file register as **binary** to git, grep, and most text tooling (`git diff` alone would not have caught it — this was found via a stray `grep` returning "binary file matches"). Fixed in `v0.1.1`. If a file that is plainly text ever gets treated as binary by tooling, check for stray control bytes before assuming it is a tooling bug.

## Known pitfall: a duplicated fence-toggle silently hid content twice (`v0.2.2`/`v0.2.3`)

`mdc.ts`, `tables.ts`, and `list-tighten.ts` each used to keep their own local `inCode`/`inComment` booleans to skip over fenced code and multi-line HTML comments, hand-typed rather than shared. A commented-out fenced code cell (`<!-- \`\`\`{r} … \`\`\` -->` — a real Quarto pattern for a dormant code chunk) embeds a fence marker mid-line inside the comment; a naive scanner that only checks "does this trimmed line start with `` ``` ``" sees that embedded marker as a real fence open/close and flips its toggle. Once flipped, the scanner believes it's inside a code block for the rest of the file — silently hiding every MDC block (`v0.2.2`) or every table (`v0.2.3`) after that point. The two bugs were the *same* mistake, found and fixed independently in two different files, because the scanning logic itself was duplicated rather than shared. `reflow.ts` never had this bug — it solves the problem a structurally different way (it consumes a whole comment's lines directly, never letting the fence check see them) — but `frontmatter.ts` has never needed fence-awareness at all, so it isn't part of this pitfall.

Fixed in `v0.2.3` by extracting `fences.ts`: one shared `computeFenceProtectedLines` (plus the `isFenceMarker` / `isCommentOpener` / `isCommentCloser` predicates it's built from) that `mdc.ts` and `tables.ts` now both call instead of reimplementing the scan, and that `list-tighten.ts` and `reflow.ts` use for the marker checks their own, differently-shaped control flow still needs. If a third copy of "is this line inside a fence/comment" ever gets hand-written again instead of importing from `fences.ts`, that's the bug recurring a third time.
