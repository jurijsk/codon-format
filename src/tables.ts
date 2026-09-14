/**
 * tables.ts — the GFM table engine: parsing table blocks out of raw lines, computing column
 * widths (plain pipe-aligned at width 0, or water-style set-width fitting with wrapped
 * continuation rows), and re-emitting them. Adapted from the water project's format-markdown
 * scripts, with two deliberate upgrades: column ALIGNMENT (`:---` / `:---:` / `---:`) is preserved
 * (water always writes plain dashes), and a row with MORE cells than the header pads every row out
 * to the widest instead of losing cells. A row with FEWER cells than the header (GFM's own
 * row-spanning-note convention — no real colspan exists in pipe tables) goes the other way: it
 * keeps its true, smaller cell count rather than being padded, and — when wrapped — does so at
 * the table's full width rather than one column's share of it, since it isn't really "in" any one
 * column to begin with. See emitTable/scanTables. See ../docs/design.md for the width-regime and
 * cross-table-matching rationale.
 */
import { computeMdcBlockLines } from './mdc.js';
import { computeFenceProtectedLines } from './fences.js';

/** Split a `| a | b |` row into trimmed cells, honouring escaped pipes (`\|` stays in-cell). */
export function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith('|')) {
		s = s.slice(1);
	}
	if (s.endsWith('|') && !s.endsWith('\\|')) {
		s = s.slice(0, -1);
	}
	return s.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** True for a GFM delimiter row (`| --- | :-: |`) — every cell only `:`/`-` with ≥1 dash. */
export function isDelimiterLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes('|') || !trimmed.startsWith('|')) {
		return false;
	}
	const cells = splitTableRow(trimmed);
	if (cells.length === 0) {
		return false;
	}
	return cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, '')));
}

const MIN_COLUMN_WIDTH = 3;
/** The narrowest meaningful set width — below this the shrink loop can't do useful work. */
export const MIN_TABLE_WIDTH = 40;

export type ColumnAlign = 'left' | 'center' | 'right' | null;

function delimiterAlignOf(cell: string): ColumnAlign {
	const c = cell.replace(/\s+/g, '');
	if (/^:-+:$/.test(c)) {
		return 'center';
	}
	if (/^:-+$/.test(c)) {
		return 'left';
	}
	if (/^-+:$/.test(c)) {
		return 'right';
	}
	return null;
}

/** A delimiter cell exactly `width` characters wide, carrying its alignment colons. */
function delimiterCell(align: ColumnAlign, width: number): string {
	const w = Math.max(width, MIN_COLUMN_WIDTH);
	switch (align) {
		case 'left':
			return `:${'-'.repeat(w - 1)}`;
		case 'center':
			return `:${'-'.repeat(w - 2)}:`;
		case 'right':
			return `${'-'.repeat(w - 1)}:`;
		default:
			return '-'.repeat(w);
	}
}

/** Minimal (unpadded) delimiter cell — the logical/serializer spelling. */
function minimalDelimiter(align: ColumnAlign): string {
	switch (align) {
		case 'left':
			return ':---';
		case 'center':
			return ':---:';
		case 'right':
			return '---:';
		default:
			return '---';
	}
}

/** `| cell | cell |` line length for the given column widths (plus the block's indent). */
function totalLineLength(widths: number[], indentLength: number): number {
	return widths.reduce((sum, w) => sum + w, 0) + widths.length * 3 + 1 + indentLength;
}

/**
 * Column widths for a table. Base width = longest cell (pipe-aligned columns). When fitting to
 * `maxLineLength`, shrink the widest column stepwise toward the target — but never below a
 * column's FLOOR: the longest whitespace-unbreakable token, and the whole header cell (a GFM
 * header cannot wrap — the delimiter must sit on the very next line). If the floors don't fit,
 * the table settles at the minimal achievable width above the target: wider than asked, every
 * word intact.
 */
export function computeColumnWidths(rows: string[][], cols: number, maxLineLength: number, indentLength: number): number[] {
	const widths: number[] = [];
	const floors: number[] = [];
	for (let col = 0; col < cols; col += 1) {
		let maxCell = 0;
		let floor = MIN_COLUMN_WIDTH;
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
			const cell = (rows[rowIndex][col] ?? '').trim();
			maxCell = Math.max(maxCell, cell.length);
			if (rowIndex === 0) {
				floor = Math.max(floor, cell.length); // header cell is unbreakable
				continue;
			}
			for (const token of cell.split(/\s+/)) {
				floor = Math.max(floor, token.length);
			}
		}
		const base = Math.max(maxCell, MIN_COLUMN_WIDTH);
		widths.push(base);
		floors.push(floor);
	}
	while (maxLineLength > 0 && totalLineLength(widths, indentLength) > maxLineLength) {
		let widest = -1;
		let widestWidth = -1;
		for (let col = 0; col < widths.length; col += 1) {
			if (widths[col] <= floors[col]) {
				continue;
			}
			if (widths[col] > widestWidth) {
				widestWidth = widths[col];
				widest = col;
			}
		}
		if (widest === -1) {
			break;
		} // every column is at its floor
		widths[widest] -= 1;
	}
	return widths;
}

/**
 * Wrap a cell's text at whitespace into lines of at most `width` characters. A token longer
 * than `width` overflows onto its own line WHOLE — never sliced: a sliced `idempo`/`tent` would
 * rejoin as `idempo tent` when the wrapped lines are later read back and re-joined with a space.
 */
export function wrapCell(rawValue: string, width: number): string[] {
	const value = rawValue.trim();
	if (!value) {
		return [''];
	}
	const lines: string[] = [];
	let current = '';
	for (const token of value.split(/\s+/)) {
		if (!current) {
			current = token;
			continue;
		}
		if (current.length + 1 + token.length <= width) {
			current = `${current} ${token}`;
			continue;
		}
		lines.push(current);
		current = token;
	}
	if (current) {
		lines.push(current);
	}
	return lines.length === 0 ? [''] : lines;
}

export interface ParsedTable {
	indent: string;
	aligns: ColumnAlign[];
	rows: string[][];
	cols: number;
}

/** Exact header key for cross-table width matching: cell text in order. Two tables with the same
 *  key (same labels, same order) are a "same schema" group — see computeGroupWidths. */
export function tableHeaderKey(table: ParsedTable): string {
	return table.rows[0].map((cell) => cell.trim()).join(' ');
}

/** Column widths shared by every table in a header-matched group, computed as if all their rows
 *  (one shared header + every table's body rows, concatenated) were a single table — so the same
 *  column lines up at the same width across every occurrence (e.g. one table per doc section,
 *  repeating the same columns). Callers only invoke this for groups of 2+ tables. */
export function computeGroupWidths(tables: ParsedTable[], tableWidth: number): number[] {
	const mergedRows = [tables[0].rows[0], ...tables.flatMap((table) => table.rows.slice(1).filter((row) => row.length === table.cols))];
	const indentLength = Math.max(...tables.map((table) => table.indent.length));
	return computeColumnWidths(mergedRows, tables[0].cols, tableWidth, indentLength);
}

/** If a sparse row's own content needs more horizontal room than the real columns currently add
 *  up to, grow those columns (evenly, remainder to the first ones) so every row's trailing pipe
 *  still lines up down the page — up to `cap` (the table's total rendered width, "| ... |"
 *  included; `Infinity` at width 0, where alignment always wins unconditionally, see design.md's
 *  "alignment always wins"). At a nonzero tableWidth, `cap` is that width: real columns widen to
 *  close as much of the gap as fits within it, but never past it just for a sparse row's sake —
 *  emitTable's own sparse-row wrapping (see emitSparse) takes over for whatever doesn't fit. */
function widenForSparseRows(widths: number[], rows: string[][], cols: number, indentLength: number, cap: number): number[] {
	const sparseRows = rows.filter((row) => row.length < cols);
	if (sparseRows.length === 0) {
		return widths;
	}
	const rowWidth = (row: string[]): number => indentLength + 4 + row.map((cell) => (cell ?? '').trim()).join(' | ').length;
	const naturalTotal = totalLineLength(widths, indentLength);
	const desiredTotal = Math.max(naturalTotal, ...sparseRows.map(rowWidth));
	const targetTotal = Math.min(desiredTotal, Math.max(cap, naturalTotal));
	const deficit = targetTotal - naturalTotal;
	if (deficit <= 0) {
		return widths;
	}
	const share = Math.floor(deficit / widths.length);
	const remainder = deficit % widths.length;
	return widths.map((w, col) => w + share + (col < remainder ? 1 : 0));
}

/** Emit one table at the given width: 0 = one padded line per logical row; >0 = cells wrapped
 *  at whitespace onto padded continuation rows (the header never wraps). `sharedWidths`, when
 *  given (a header-matched group), overrides this table's own per-table width computation. */
export function emitTable(table: ParsedTable, tableWidth: number, out: string[], sharedWidths?: number[]): void {
	const { indent, aligns, rows, cols } = table;
	const fullRows = rows.filter((row) => row.length === cols);
	const naturalWidths = sharedWidths ?? computeColumnWidths(fullRows, cols, tableWidth, indent.length);
	// A long sparse row can still widen the real columns to meet it — up to `tableWidth` (or
	// unconditionally at width 0, where alignment always wins over any target). This is what lets
	// a sparse row that fits within `tableWidth` unwrapped actually render on one line instead of
	// wrapping just because the real columns' own natural width happened to be narrower — the real
	// columns use whatever headroom `tableWidth` leaves after their own content, instead of that
	// headroom going to waste while the sparse row wraps unnecessarily tighter than it has to.
	const widths = widenForSparseRows(naturalWidths, rows, cols, indent.length, tableWidth === 0 ? Infinity : tableWidth);
	const padLine = (cells: string[]): string => `${indent}| ${cells.map((cell, col) => (cell ?? '').trim().padEnd(widths[col], ' ')).join(' | ')} |`;
	const totalInner = totalLineLength(widths, indent.length) - indent.length - 4;
	// A sparse row (see scanTables) never pads its own missing trailing cells — it isn't tabular
	// data competing for column space. At a nonzero tableWidth it WRAPS like any other row, but at
	// the table's FULL available width rather than one column's slice of it ("it should occupy as
	// much space as there is in the table" — it isn't really "in" any one column to begin with).
	// Either way, EVERY physical line — wrapped or not — pads out to `totalInner` so its trailing
	// pipe lands exactly where every other row's does; that's the same "alignment always wins" (at
	// width 0) / "fit the target width" (at width N) guarantee the rest of the table gets, just
	// reaching a sparse row through padding instead of through computeColumnWidths. NOTE: unlike
	// the main formatMarkdown pipeline (which only ever calls emitTable at width 0 — nonzero width
	// goes through emitGridTable instead, see markdown-format.ts), a direct caller invoking this
	// exported function at a nonzero width gets output whose wrapped physical lines are NOT
	// reassembled back into one logical row by scanTables on a later parse; each becomes its own
	// separate sparse row instead. This wrapping mode is a rendering-only convenience for direct
	// callers, not a round-trip-safe on-disk format.
	const emitSparse = (row: string[]): void => {
		const cells = row.map((cell) => (cell ?? '').trim());
		if (tableWidth === 0) {
			const built = cells.map((cell, col) => (col < cells.length - 1 ? cell.padEnd(widths[col], ' ') : cell)).join(' | ');
			out.push(`${indent}| ${built.padEnd(totalInner, ' ')} |`);
			return;
		}
		// Every cell but the last (usually there IS no other cell) pads to its real column's width,
		// so it stays visually anchored under that column; the last cell wraps into whatever's left
		// of the row's total budget.
		const fixed = cells.slice(0, -1).map((cell, col) => cell.padEnd(widths[col], ' '));
		const fixedWidth = fixed.reduce((sum, cell) => sum + cell.length + 3, 0);
		const wrapWidth = Math.max(totalInner - fixedWidth, MIN_COLUMN_WIDTH);
		const wrappedLast = wrapCell(cells[cells.length - 1], wrapWidth);
		for (let lineIndex = 0; lineIndex < wrappedLast.length; lineIndex += 1) {
			const lineCells = lineIndex === 0 ? [...fixed, wrappedLast[lineIndex]] : [...fixed.map((cell) => ' '.repeat(cell.length)), wrappedLast[lineIndex]];
			out.push(`${indent}| ${lineCells.join(' | ').padEnd(totalInner, ' ')} |`);
		}
	};
	out.push(padLine(rows[0]));
	out.push(`${indent}| ${widths.map((w, col) => delimiterCell(aligns[col], w)).join(' | ')} |`);
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex];
		if (row.length < cols) {
			emitSparse(row);
			continue;
		}
		if (tableWidth === 0) {
			out.push(padLine(row));
			continue;
		}
		const wrapped = row.map((cell, col) => wrapCell(cell ?? '', widths[col]));
		const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
		for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
			out.push(padLine(wrapped.map((cellLines) => cellLines[lineIndex] ?? '')));
		}
	}
}

/** Emit one table in the LOGICAL, minimal (serializer-style) form: one `| a | b |` line per
 *  logical row, no column-width padding — the form Codon's webview is fed. */
export function minifyTable(table: ParsedTable, out: string[]): void {
	const { indent, aligns, rows, cols } = table;
	// A sparse row keeps its true (fewer) cell count here too — see emitTable/scanTables for why
	// padding it back to `cols` would erase the information that round-trips it losslessly.
	const line = (cells: string[]): string =>
		`${indent}| ${(cells.length < cols ? cells : Array.from({ length: cols }, (_, col) => cells[col] ?? '')).map((cell) => (cell ?? '').trim()).join(' | ')} |`;
	out.push(line(rows[0]));
	out.push(`${indent}| ${aligns.map(minimalDelimiter).join(' | ')} |`);
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
		out.push(line(rows[rowIndex]));
	}
}

export interface TableBlock {
	table: ParsedTable;
	/** First line of the block (the header row), inclusive. */
	start: number;
	/** One past the block's last consumed row, exclusive. */
	end: number;
}

/**
 * Find each GFM table block (a `|` row followed by a delimiter row) in `lines`. Every pipe table
 * encountered is assumed properly authored — no continuation-row collapsing (removed; grid
 * tables now own all nonzero-width wrapping unambiguously, so pipe tables no longer need a
 * heuristic to undo one) — the only row shape treated specially is a body row with exactly one
 * cell, GFM's own row-spanning-note convention (see the shaping below). Fence bodies and MDC
 * blocks are skipped. Split out from the emission walk (emitTableLines) so a caller can inspect
 * every table up front — e.g. to match headers across tables — before any of them are rendered.
 *
 * `extraSkip`, when given (a caller-computed `boolean[]` the same length as `lines`), marks
 * additional lines to skip on top of the MDC/fence check — namely grid-table block lines (see
 * grid-tables.ts's `computeGridTableBlockLines`), so a `|`-content line INSIDE a grid table's own
 * cell content is never mistaken for the start of a nested pipe table.
 */
export function scanTables(lines: string[], extraSkip?: boolean[]): TableBlock[] {
	const blocks: TableBlock[] = [];
	const mdcBlock = computeMdcBlockLines(lines);
	const fenceProtected = computeFenceProtectedLines(lines);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trimStart();
		if (mdcBlock[index] || fenceProtected[index] || extraSkip?.[index]) {
			continue;
		}
		if (!trimmed.startsWith('|') || !isDelimiterLine(lines[index + 1] ?? '')) {
			continue;
		}

		const start = index;
		const indent = line.slice(0, line.length - trimmed.length);
		const header = splitTableRow(line);
		const delims = splitTableRow(lines[index + 1]);
		const body: string[][] = [];
		index += 2;
		// A `|` line immediately followed by a delimiter-row-shaped line is NOT a reliable signal
		// of a new table's header — a genuine data row whose cells happen to be dash-only
		// placeholders (e.g. "N/A", a realistic convention in real-world data) is syntactically
		// indistinguishable from a real delimiter row, and every mainstream GFM implementation
		// (remark-gfm, marked, comark — all checked directly) treats two `|`-blocks with no blank
		// line between them as ONE table regardless, never re-triggering "table start" mid-body.
		// Matching that real-world behavior here, rather than trying to be smarter than it, is
		// the safe choice: a heuristic that "detects" a new table risks silently reformatting
		// genuine data (a placeholder row's dashes) into pure formatting dashes, which is worse
		// than the merged-table outcome it would have prevented.
		while (index < lines.length && lines[index].trimStart().startsWith('|')) {
			body.push(splitTableRow(lines[index]));
			index += 1;
		}
		const end = index;
		index -= 1; // the for-loop increments past the last consumed row

		const raw = [header, ...body];
		const cols = Math.max(...raw.map((row) => row.length));
		// Cell text is OPAQUE to the formatter — incl. `<br>` line breaks (the canonical multi-
		// line-cell form; the editor renders them as real breaks, see MdHardBreak/extensions.ts).
		// The header is always padded to `cols` — it must stay rectangular to match the delimiter
		// row. A body row with EXACTLY ONE cell is a sparse/row-spanning note (GFM has no real
		// colspan; this is that convention — see design.md) and keeps its true, unpadded cell
		// count: padding it here would erase the only signal pipe syntax has for "this row spans
		// the whole table" — a padded row with blank trailing cells is indistinguishable from an
		// ordinary short row. A row with 2..cols-1 cells is NOT that convention — a table missing
		// only its last (often-blank) column is far more likely a typo than an intentional
		// spanning note, so it's padded like any other ragged row instead (see `MORE cells than
		// the header` in this file's header comment for the symmetric case).
		const rows = [
			Array.from({ length: cols }, (_, col) => header[col] ?? ''),
			...body.map((row) => (row.length === 1 && cols > 1 ? row : Array.from({ length: cols }, (_, col) => row[col] ?? ''))),
		];
		const aligns = Array.from({ length: cols }, (_, col) => delimiterAlignOf(delims[col] ?? ''));
		blocks.push({ table: { indent, aligns, rows, cols }, start, end });
	}
	return blocks;
}

/** Walk `lines`, re-emitting each pre-scanned table block via `emit` and passing every other line
 *  through verbatim. */
export function emitTableLines(lines: string[], blocks: TableBlock[], emit: (table: ParsedTable, out: string[]) => void): string[] {
	const out: string[] = [];
	let blockIndex = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const block = blocks[blockIndex];
		if (block && block.start === index) {
			emit(block.table, out);
			index = block.end - 1; // the for-loop increments past the block's last consumed row
			blockIndex += 1;
			continue;
		}
		out.push(lines[index]);
	}
	return out;
}

/** Convenience wrapper for callers with no need to inspect tables before emitting them. */
export function transformTableLines(lines: string[], emit: (table: ParsedTable, out: string[]) => void): string[] {
	return emitTableLines(lines, scanTables(lines), emit);
}
