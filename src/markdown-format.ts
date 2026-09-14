/**
 * markdown-format.ts — the public entry point for `@jurijsk/codon-format`: wires the
 * individual passes into the one function Codon and the CLI both call. Read THIS file to see the
 * SHAPE of the pipeline; each pass's own reasoning lives in its own module:
 *
 *   - eol.ts          — line-ending detection/normalization
 *   - frontmatter.ts  — YAML metadata block detection (so it's never touched by other passes)
 *   - mdc.ts          — MDC block-component detection (same reason)
 *   - reflow.ts       — paragraph/list-item reflow (one line each)
 *   - list-tighten.ts — dropping blank lines between simple list items
 *   - tables.ts       — the GFM table engine: parsing, column widths, wrapping, emission
 *   - discover.ts     — project-wide markdown file discovery (`discoverMarkdownFiles`, and the
 *                       CLI's `--git-driven`/`--all`)
 *
 * See ../docs/design.md for the full design writeup (why each decision, not just what it does).
 *
 * A PURE text→text pass. No DOM, no editor, no TipTap — plain string processing, adapted from the
 * water project's format-markdown scripts. Vscode-free AND DOM-free, so it runs synchronously in
 * the `codon-format` CLI (format-cli.ts, this package), as a library import, and under
 * plain-node vitest.
 *
 * THE SINGLE LAYOUT AUTHORITY for the jurijsk.codon VS Code extension (a separate repo,
 * https://github.com/jurijsk/codon, which depends on this package). Codon's webview serializer
 * produces semantically-correct markdown; what the raw file LOOKS like is decided here, and only
 * here:
 *   - every Codon save is piped through formatMarkdown() by Codon's host (markdownEditor.ts,
 *     imported directly — never spawned as a subprocess);
 *   - Codon's Format Document provider (markdownFormatter.ts) and this package's own CLI run the
 *     exact same function — so editor saves, Format Document, and the CLI all agree by
 *     construction;
 *   - Codon's webview is always FED the logical width-0 form (minifyMarkdown) — it never
 *     sees, and never thinks about, raw-file layout.
 *
 * CONTRACT (pinned in test/markdown-format.test.ts, this package):
 *   1. IDEMPOTENT — format(format(x)) === format(x), at every width.
 *   2. PIPELINE-STABLE (verified in the jurijsk.codon repo, test/formatParity.test.ts there — it
 *      needs jsdom + the real TipTap pipeline, which can't live in this vscode-free package): for
 *      F = format(x): format(serialize(parse(F))) === F. One save cycle of a formatted file
 *      changes nothing.
 *   3. LAYOUT-ONLY — never rewrites inline spelling (emphasis markers, escapes, link encoding,
 *      list renumbering). Those stay Codon's serializer's domain.
 *
 * What passes through verbatim: YAML frontmatter (frontmatter.ts), code fences and their bodies,
 * indented code blocks, headings, blockquotes, thematic breaks / setext underlines, HTML blocks,
 * multi-line HTML comments (byte-for-byte — Codon's comment pills round-trip raw), WHOLE MDC
 * block components (mdc.ts) plus bare `:`-directive lines, link reference definitions, Quarto
 * shortcodes (`{{< ... >}}`), and lines ending in a hard break (`\` or two trailing spaces).
 */
import { dominantEol, withEol } from './eol.js';
import { reflowLines } from './reflow.js';
import { tightenListLines } from './list-tighten.js';
import { MIN_TABLE_WIDTH, scanTables, emitTable, minifyTable, tableHeaderKey, computeGroupWidths } from './tables.js';
import { scanGridTables, emitGridTable, gridToParsedTable, parsedTableToGridTable, computeGridTableBlockLines, type GridTable } from './grid-tables.js';

export type { Eol } from './eol.js';
export { dominantEol, withEol } from './eol.js';
export { computeYamlMetadataBlockLines } from './frontmatter.js';
export { computeMdcBlockLines } from './mdc.js';
export { reflowLines } from './reflow.js';
export { tightenListLines } from './list-tighten.js';
// The table engine itself is public API: a caller that BUILDS tables (rather than reformatting a
// whole document) can size and emit them with the exact width logic formatMarkdown uses — e.g.
// DAINA's converter pipe-aligns the tables inside its page fences (which formatMarkdown, fence-
// protected by design, would never reach) with computeColumnWidths at width 0.
export { splitTableRow, isDelimiterLine, computeColumnWidths, emitTable, minifyTable, scanTables, emitTableLines, transformTableLines, tableHeaderKey, computeGroupWidths, type ParsedTable, type TableBlock, type ColumnAlign } from './tables.js';
export { discoverMarkdownFiles, type DiscoverMarkdownFilesOptions, type DiscoveryMode } from './discover.js';

export interface FormatMarkdownOptions {
	/** Raw-file table width: 0 (default) = one pipe-aligned line per logical row (the logical /
	 *  commit form); ≥40 = wrap cell text onto a Pandoc/reST-style grid table (`+---+` borders,
	 *  see grid-tables.ts) so table lines stay under this many characters. Values 1–39 are
	 *  clamped up to 40. */
	tableWidth?: number;
	/** When `true`, tables with the same structure (exact header match — same labels, same order)
	 *  anywhere in the document have their column widths aligned with each other, instead of each
	 *  sizing to only its own content. Default `false`. */
	alignTablesWidth?: boolean;
	/** When `false`, skip paragraph/list-item reflow (`reflowLines`) and list-tightening
	 *  (`tightenListLines`) entirely — every line passes through exactly as authored, tables
	 *  aside. Default `true` (Codon's canonical one-line-per-paragraph style). Set to `false` to
	 *  make `formatMarkdown` agree with `minifyMarkdown` on prose: `minifyMarkdown` never reflows,
	 *  so only with this off do the two treat non-table content the same way. A soft line break
	 *  inside a paragraph is valid GFM either way — this only changes whether it survives as its
	 *  own physical line or gets joined into one, never the rendered result. */
	reflow?: boolean;
	/** When `true`, never recognize a Pandoc/reST-style grid table (`+---+` borders) as a table at
	 *  all — a block matching that border syntax passes through byte-identical instead of being
	 *  parsed and re-emitted as a pipe table. Default `false` (grid tables detected and normalized
	 *  as usual). Meant for formatting a FRAGMENT of a larger document, where content unrelated to
	 *  this formatter (e.g. another tool's own `+---+`-bordered output) can coincidentally satisfy
	 *  the grid-table border grammar without being one; a whole well-formed file is far less likely
	 *  to contain that by accident. Detection only — has no effect on emission, so a genuine pipe
	 *  table still becomes a grid table as usual at a nonzero `tableWidth`. */
	ignoreGridTables?: boolean;
	/** When `false`, don't force exactly one trailing newline — every trailing newline is stripped
	 *  and none is added back, so the result never ends in `\n` at all. Default `true` (the normal
	 *  whole-FILE guarantee: exactly one final newline, keeping the save cycle byte-stable on the
	 *  last byte). Meant for formatting a FRAGMENT that will be embedded inside a larger document,
	 *  where a forced trailing newline would be unwanted. */
	trailingNewline?: boolean;
}

/**
 * Format markdown text to Codon's canonical layout. Pure string→string; preserves the input's
 * dominant EOL, so callers pass `document.getText()` / file contents directly and write the
 * result back without EOL bookkeeping.
 */
/** One table block found in the document, regardless of which on-disk syntax it was written in
 *  (plain GFM pipe, or grid) — see grid-tables.ts's header comment for why a unified
 *  representation exists at all. Every block is normalized to `GridTable` up front: a pipe table
 *  converts trivially (`parsedTableToGridTable` — its existing arity-1 whole-row-note convention
 *  becomes a colSpan-`cols` cell, everything else colSpan-1), and `GridTable` is a strict
 *  superset of what a pipe table can express, so nothing about a spanless source table is lost
 *  going through this conversion. */
interface FoundTable {
	table: GridTable;
	start: number;
	end: number;
	/** A cell spanning SOME but not all columns — see docs/design.md: such a table is excluded
	 *  from cross-table width matching (`alignTablesWidth`), a deliberate, narrow scope limit,
	 *  not a regression — a table using only the pre-existing whole-row-note convention
	 *  (colSpan === cols) keeps matching exactly as it always has. */
	hasPartialSpan: boolean;
}

/** Find every table block (pipe or grid syntax) in `lines`, in document order. `scanTables`
 *  is given the grid-table block lines to skip so a `|`-content line INSIDE a grid table's own
 *  cell text is never mistaken for the start of a nested pipe table (blocks of the two syntaxes
 *  can never otherwise overlap — a grid table always starts with `+`, a pipe table with `|`).
 *  `ignoreGridTables` (see `FormatMarkdownOptions`) skips grid-table detection entirely — nothing
 *  is protected from the pipe scan either, since there are no grid blocks left to overlap with. */
function scanAllTables(lines: string[], ignoreGridTables: boolean): FoundTable[] {
	const gridBlockLines = ignoreGridTables ? undefined : computeGridTableBlockLines(lines);
	const pipeBlocks = scanTables(lines, gridBlockLines).map((block) => ({
		table: parsedTableToGridTable(block.table),
		start: block.start,
		end: block.end,
		hasPartialSpan: false, // a pipe-sourced table only ever has the whole-row (colSpan===cols) shape
	}));
	const gridBlocks = ignoreGridTables
		? []
		: scanGridTables(lines).map((block) => ({
				table: block.table,
				start: block.start,
				end: block.end,
				hasPartialSpan: block.table.cells.some((cell) => cell.colSpan > 1 && cell.colSpan < block.table.cols),
			}));
	return [...pipeBlocks, ...gridBlocks].sort((a, b) => a.start - b.start);
}

export function formatMarkdown(content: string, options: FormatMarkdownOptions = {}): string {
	const raw = options.tableWidth ?? 0;
	const tableWidth = raw <= 0 ? 0 : Math.max(raw, MIN_TABLE_WIDTH);
	const alignTablesWidth = options.alignTablesWidth ?? false;
	const reflow = options.reflow ?? true;
	const ignoreGridTables = options.ignoreGridTables ?? false;
	const trailingNewline = options.trailingNewline ?? true;
	const splitLines = content.split(/\r?\n/);
	const lines = reflow ? tightenListLines(reflowLines(splitLines)) : splitLines;
	const blocks = scanAllTables(lines, ignoreGridTables);
	// Tables with an EXACT header match (same labels, same order) share one set of column widths
	// — computed from their rows combined — so the same column lines up at the same width across
	// every occurrence (e.g. one table per doc section, repeating the same schema). Computed on
	// each block's flattened (ParsedTable) projection so the exact same matching this package has
	// always done for plain tables is unaffected; a block with a partial span never enters a
	// group (see FoundTable.hasPartialSpan).
	const groupWidths = new Map<FoundTable, number[]>();
	if (alignTablesWidth) {
		const groups = new Map<string, FoundTable[]>();
		for (const block of blocks) {
			if (block.hasPartialSpan) {
				continue;
			}
			const key = tableHeaderKey(gridToParsedTable(block.table));
			const group = groups.get(key) ?? [];
			group.push(block);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			if (group.length < 2) {
				continue;
			}
			const widths = computeGroupWidths(
				group.map((block) => gridToParsedTable(block.table)),
				tableWidth,
			);
			for (const block of group) {
				groupWidths.set(block, widths);
			}
		}
	}
	const out: string[] = [];
	let blockIndex = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const block = blocks[blockIndex];
		if (block && block.start === index) {
			if (tableWidth === 0) {
				emitTable(gridToParsedTable(block.table), 0, out, groupWidths.get(block));
			} else {
				emitGridTable(block.table, tableWidth, out, groupWidths.get(block));
			}
			index = block.end - 1;
			blockIndex += 1;
			continue;
		}
		out.push(lines[index]);
	}
	const joined = out.join('\n');
	// Exactly ONE final newline (the serializer emits none; hand-authored files vary) — a
	// formatter guarantee, and what keeps the save cycle byte-stable on the last byte. Skipped
	// entirely when `trailingNewline` is off: every trailing newline is stripped and none added
	// back, for a fragment meant to be embedded inside a larger document.
	const trimmed = joined.replace(/\n+$/, '');
	const formatted = trailingNewline ? (trimmed === '' ? '' : `${trimmed}\n`) : trimmed;
	return withEol(formatted, dominantEol(content));
}

/**
 * The LOGICAL (width-0, minimal) form of `content`, touching ONLY tables: a grid table's border
 * lines collapse into their logical rows, cells unpadded, spans flattened (see grid-tables.ts's
 * `gridToParsedTable`) — everything else byte-identical. This is what Codon's host feeds the
 * webview (markdownEditor.ts): the WYSIWYG must model logical rows, never the raw file's grid
 * syntax, and the minimal style matches the serializer's own so the webview's echo comparison
 * still works.
 */
export function minifyMarkdown(content: string): string {
	const lines = content.split(/\r?\n/);
	const blocks = scanAllTables(lines, false);
	const out: string[] = [];
	let blockIndex = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const block = blocks[blockIndex];
		if (block && block.start === index) {
			minifyTable(gridToParsedTable(block.table), out);
			index = block.end - 1;
			blockIndex += 1;
			continue;
		}
		out.push(lines[index]);
	}
	return withEol(out.join('\n'), dominantEol(content));
}
