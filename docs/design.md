# How the formatter works, and why

This is the design writeup behind the formatter's source — the *what* lives in each file's own
header comment (kept in sync with this doc); this covers the *why*, the internals worth knowing
before touching the table engine, and pitfalls that already bit us once.

## File layout

The formatter is split by concern, not left as one large file — the file you want is usually the
answer to "where does X happen":

| File                 | Answers                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown-format.ts` | The orchestrator — `formatMarkdownText`/`tablesToLogicalRows`, wiring the passes below into the one function Codon and the CLI call. Read this file first; it's the pipeline's shape, not its internals. |
| `frontmatter.ts`     | Where do we detect YAML frontmatter?                                                                                                                                                                     |
| `mdc.ts`             | Where do we detect MDC block components (`::name … ::`)?                                                                                                                                                 |
| `reflow.ts`          | Where do we join wrapped paragraphs/list items onto one line?                                                                                                                                            |
| `list-tighten.ts`    | Where do we drop blank lines between simple list items?                                                                                                                                                  |
| `tables.ts`          | Where do we format tables — parsing, column widths, wrapping, cross-table matching, emission?                                                                                                            |
| `eol.ts`             | Where do we detect/normalize line endings?                                                                                                                                                               |

`frontmatter.ts` and `mdc.ts` exist for **detection only** — `reflow.ts`, `list-tighten.ts`, and
`tables.ts` each call into them to find out which lines to leave completely alone, rather than
duplicating that detection logic three times.

## The contract, restated

- **Idempotent** at every width: `format(format(x)) === format(x)`.
- **Pipeline-stable**: `format(serialize(parse(format(x)))) === format(x)` — one save cycle of
  already-formatted text changes nothing. This half of the contract can only be verified against a
  real markdown-editing pipeline (parse → edit → serialize), which needs a DOM (jsdom) — this
  package deliberately doesn't have one, so that half is pinned in the **consumer** repo instead:
  [jurijsk/codon](https://github.com/jurijsk/codon)'s `test/formatParity.test.ts`, which imports
  this package and drives it against Codon's real TipTap/ProseMirror pipeline. If you change
  table/paragraph layout here, that test is the one that actually proves you haven't broken the
  editor round-trip — running only this package's own test suite isn't sufficient.
- **Layout-only**: never touches inline spelling (emphasis markers, escape sequences, link
  encoding, list renumbering). A formatter that also normalized `*x*` → `_x_` would be a different,
  riskier kind of tool — this one only ever moves whitespace and line breaks.

## The table engine

### Two width regimes, not a spectrum

`tableWidth` is not "pick any wrap column" — it's binary in shape:

- **`0`** — every logical row becomes exactly one raw-file line, padded so pipes align down the
  page. This is the **logical / commit form**: the byte-for-byte layout every other GFM renderer
  (GitHub, GitLab, whatever) understands correctly.
- **`N` where `N ≥ 40`** — cell text wraps at whitespace onto **continuation rows**: a raw-file-only
  row whose first cell is empty and whose other cells carry the wrapped tail of the row above. This
  is a convention *this formatter itself* invented for on-disk readability of wide tables — no
  other markdown tool recognizes it. `collapseContinuationRows` is the inverse: it runs before any
  other table work, so a file written at any width normalizes losslessly back to logical rows at
  width 0. **This is why 0 is the only commit-safe width** (see the CLI section below) — continuation
  rows outside this formatter's own reader render as extra, mostly-empty broken rows.
- Values `1–39` clamp up to 40 (`MIN_TABLE_WIDTH`) — below that the shrink-to-fit loop can't do
  anything useful with real cell content.

### Width-0 padding has no cap — alignment always wins

At width 0, columns pad to their widest cell, uncapped. An earlier version capped padding at 80
chars (`MAX_PAD_WIDTH`) so a monster cell (a key-value dump running to thousands of characters,
which real fixtures in Codon's `examples/` corpus actually contain) wouldn't force every *other*
row in that column to pad out to match it — past the cap, the monster cell kept its full content
and simply overflowed its own column, alignment giving up before content did. That traded away the
one thing width-0 exists to guarantee: every row's pipes actually line up. The cap is gone now — a
genuinely huge cell inflates its column's padding for every row, which is the correct trade for a
regime whose entire purpose is visual alignment. Content is still never truncated.

### The shrink-to-fit loop (width N)

`computeColumnWidths` starts every column at its natural (longest-cell) width, then — only when
fitting to a target `maxLineLength` — repeatedly shrinks the currently-widest column by one
character until the total line length fits or every column has hit its **floor**. A column's floor
is the longer of: its header cell (a GFM header can't wrap; the delimiter row must sit on the very
next line) and the longest whitespace-unbreakable token in any body cell. If the floors alone don't
fit the target, the table settles at the minimal width *above* the target that keeps every word
whole — wider than asked, never with a word sliced (a sliced `idempo`/`tent` would round-trip back
together as `idempo tent`, corrupting content).

### Cross-table width matching

Tables with an **exact header match** — same cell text, same column count, same order, anywhere in
the same document — share one set of column widths, computed as if all their rows (one shared
header + every table's body rows, concatenated) were a single table. Implementation:
`scanTables`/`emitTableLines` split table-block *discovery* from *emission* specifically so
`formatMarkdownText` can group same-header tables and pre-compute shared widths before any of them
render — a table's own width is only ever computed standalone (`computeColumnWidths` on just its
own rows) when it's the only one with that header in the document.

This exists because a document with several tables sharing a schema (one per section — a repo
inventory, a per-environment config table, whatever) reads far better with visually consistent
columns than with each table independently squeezed to its own narrowest content. Matching is
**exact text**, not fuzzy/order-insensitive — two tables with the same labels in a different order
are treated as different schemas on purpose; silently re-mapping columns by label would be a much
riskier, harder-to-predict transform for comparatively little benefit.

## The CLI (`codon-format`)

### `--check` is a general gate, not a commit-only one

`--check --width N` validates against whatever width you asked for — it does **not** silently
coerce to 0. Early on this package briefly *rejected* `--check` combined with a nonzero `--width`,
on the theory that `--check`'s only legitimate use was "is this safe to commit" (which is always
width 0). That was reverted: it's the caller's call whether they want to gate on some other width
(testing, debugging, a downstream project with its own on-disk convention) — the CLI trusts the
caller rather than enforcing one opinion about what `--check` is for. What's true regardless: **only
width 0 is safe to commit** (see above) — that's documentation/guidance, not something the tool
polices.

### Auto-fix vs. gate — pick the one that matches where you're calling it from

- **CI** (a PR check that shouldn't silently mutate the branch): `codon-format $(git ls-files
  '*.md') --check`.
- **Local pre-commit hook** (friendlier — let it fix and continue, the way `prettier --write` does
  under lint-staged):
  ```bash
  files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md')
  [ -z "$files" ] && exit 0
  npx codon-format $files
  git add $files
  ```
  `--check` in a *local* hook just means "fail the commit and make the human re-run the formatter
  themselves" — usually not what you want for pure formatting.

## Known pitfall: watch for control bytes silently introduced by editing tools

`tableHeaderKey`'s join separator was briefly a **raw NUL byte (U+0000)** instead of the
literal text `.join(' ')` — an editing-tool artifact, not a deliberate choice. It didn't break
anything at *runtime* — JS strings permit embedded NUL bytes — but it made the file register
as **binary** to git, grep, and most text tooling (`git diff` alone would not have caught it —
this was found via a stray `grep` returning "binary file matches"). Fixed in `v0.1.1`. If a
file that is plainly text ever gets treated as binary by tooling, check for stray control bytes
before assuming it is a tooling bug.
