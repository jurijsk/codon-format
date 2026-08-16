/**
 * tables.ts — the GFM table engine: parsing table blocks out of raw lines, computing column
 * widths (plain pipe-aligned at width 0, or water-style set-width fitting with wrapped
 * continuation rows), and re-emitting them. Adapted from the water project's format-markdown
 * scripts, with two deliberate upgrades: column ALIGNMENT (`:---` / `:---:` / `---:`) is
 * preserved (water always writes plain dashes), and ragged rows pad out to the widest row instead
 * of losing cells. See ../docs/design.md for the width-regime and cross-table-matching rationale.
 */
import { computeMdcBlockLines } from './mdc';
import { computeFenceProtectedLines } from './fences';

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

type ColumnAlign = 'left' | 'center' | 'right' | null;

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

/**
 * Merge continuation rows back into their logical rows (water's inverse-wrap): a row whose
 * FIRST cell is empty while any other cell has text is the wrapped tail of the row above —
 * its cell text joins the corresponding cell with a space. A continuation directly under the
 * header stays (there is no data row to join). This runs before ALL other table work, so a
 * file written at any width normalizes losslessly back to logical rows.
 */
function collapseContinuationRows(rows: string[][]): string[][] {
	if (rows.length <= 2) {
		return rows;
	}
	const collapsed: string[][] = [rows[0]];
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex].slice();
		const firstCellEmpty = row[0].trim().length === 0;
		const hasAnyOtherText = row.slice(1).some((cell) => cell.trim().length > 0);
		if (!firstCellEmpty || !hasAnyOtherText || collapsed.length === 1) {
			collapsed.push(row);
			continue;
		}
		const previous = collapsed[collapsed.length - 1];
		for (let col = 0; col < row.length; col += 1) {
			const continuation = row[col].trim();
			if (!continuation) {
				continue;
			}
			const current = previous[col].trim();
			previous[col] = current ? `${current} ${continuation}` : continuation;
		}
	}
	return collapsed;
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
function computeColumnWidths(rows: string[][], cols: number, maxLineLength: number, indentLength: number): number[] {
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
 * than `width` overflows onto its own line WHOLE — never sliced: collapseContinuationRows
 * rejoins with a space, so a sliced `idempo`/`tent` would round-trip to `idempo tent`.
 */
function wrapCell(rawValue: string, width: number): string[] {
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
	const mergedRows = [tables[0].rows[0], ...tables.flatMap((table) => table.rows.slice(1))];
	const indentLength = Math.max(...tables.map((table) => table.indent.length));
	return computeColumnWidths(mergedRows, tables[0].cols, tableWidth, indentLength);
}

/** Emit one table at the given width: 0 = one padded line per logical row; >0 = cells wrapped
 *  at whitespace onto padded continuation rows (the header never wraps). `sharedWidths`, when
 *  given (a header-matched group), overrides this table's own per-table width computation. */
export function emitTable(table: ParsedTable, tableWidth: number, out: string[], sharedWidths?: number[]): void {
	const { indent, aligns, rows, cols } = table;
	const widths = sharedWidths ?? computeColumnWidths(rows, cols, tableWidth, indent.length);
	const padLine = (cells: string[]): string => `${indent}| ${cells.map((cell, col) => (cell ?? '').trim().padEnd(widths[col], ' ')).join(' | ')} |`;
	out.push(padLine(rows[0]));
	out.push(`${indent}| ${widths.map((w, col) => delimiterCell(aligns[col], w)).join(' | ')} |`);
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex];
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
 *  logical row, no padding — the form Codon's webview is fed. */
export function emitLogicalTable(table: ParsedTable, out: string[]): void {
	const { indent, aligns, rows, cols } = table;
	const line = (cells: string[]): string => `${indent}| ${Array.from({ length: cols }, (_, col) => (cells[col] ?? '').trim()).join(' | ')} |`;
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
 * Find each GFM table block (a `|` row followed by a delimiter row) in `lines`, collapsing its
 * continuation rows to logical rows. Fence bodies and MDC blocks are skipped. Split out from the
 * emission walk (emitTableLines) so a caller can inspect every table up front — e.g. to match
 * headers across tables — before any of them are rendered.
 */
export function scanTables(lines: string[]): TableBlock[] {
	const blocks: TableBlock[] = [];
	const mdcBlock = computeMdcBlockLines(lines);
	const fenceProtected = computeFenceProtectedLines(lines);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trimStart();
		if (mdcBlock[index] || fenceProtected[index]) {
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
		const padded = raw.map((row) => Array.from({ length: cols }, (_, col) => row[col] ?? ''));
		const rows = collapseContinuationRows(padded);
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
