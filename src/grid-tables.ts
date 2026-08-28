/**
 * grid-tables.ts — the grid-table engine: a Pandoc/reStructuredText-style `+---+---+` / `|`
 * bordered table, used ONLY at a nonzero `tableWidth` (see markdown-format.ts). Unlike the plain
 * GFM pipe-table wrap convention in tables.ts (a continuation row recognized by an empty first
 * cell — a heuristic that breaks when the FIRST column itself wraps, or ambiguates with a
 * genuine short row), a grid table's cell boundaries come from the border lines' fixed `+`
 * character positions, held constant down the whole table. A wrapped or spanning cell is
 * therefore never inferred from content shape — it's read directly off the border geometry. See
 * docs/design.md's "Grid tables" section for the full design writeup and worked examples.
 *
 * PHASE 1 SCOPE: full-row spans and partial column spans (colspan) are supported, in both
 * directions (parse and emit). Row spans (a cell spanning multiple ROW-bands vertically) are NOT
 * yet supported — a border line with a blank (space-filled) segment, which is how a row span
 * would be signalled, is treated as unrecognized grid syntax: the whole block is left untouched,
 * never partially or incorrectly parsed. This is a deliberate, documented scope limit (see
 * design.md), not an oversight — the height-distribution algorithm a row span needs is
 * substantially riskier than colspan alone and is planned as a following, separately-scoped pass.
 *
 * Width 0 NEVER uses grid syntax — it's the one form every GFM renderer understands, and stays
 * that way unconditionally (see design.md's "Two width regimes"). A grid table is always
 * flattened back to a plain (non-spanning) pipe table at width 0 — see `gridToParsedTable`.
 *
 * PARSING PRINCIPLE: a cell's boundaries are read from its content lines' literal `|` characters
 * — the same delimiter-split `splitTableRow` already uses for plain pipe tables — NOT from
 * matching character positions against a position set fixed once at the top of the table. This
 * is deliberate: someone hand-editing a grid table (the whole point of the format) routinely
 * widens one cell's text without manually re-padding every border/pipe mark around it, and a
 * position-anchored parser would misread — or worse, silently truncate its read of — everything
 * from that edited row onward. Reading by delimiter instead means an edited row (and every row
 * after it) still parses correctly regardless of how far its width has drifted from its
 * neighbours; the next `emitGridTable` pass re-establishes consistent alignment for all of them.
 * A band whose own cell count sits strictly between 1 and the table's column count (a genuine
 * PARTIAL colspan, not the classic whole-row note) is recovered by snapping that band's own `|`
 * character positions to the nearest of the HEADER row's own positions — tolerant of drift, but
 * requires the header itself to still be a clean, full-width reference; see `snapBandToColumns`.
 * Border lines are used only to find where one row-band ends and the next begins, to detect the
 * header separator, and to reject row-span syntax (unsupported) — never for cell-text extraction.
 * Emission still draws borders that visually reflect spans (see `drawBorder`'s merge rule) — that
 * stays purely cosmetic, since parsing never depends on it.
 */
import { computeFenceProtectedLines } from './fences.js';
import { computeMdcBlockLines } from './mdc.js';
import { computeColumnWidths, wrapCell, splitTableRow, type ColumnAlign, type ParsedTable } from './tables.js';

/** Mirrors tables.ts's own MIN_COLUMN_WIDTH — the shrink loop can't do anything useful below this. */
const MIN_COLUMN_WIDTH = 3;

/** One logical cell, anchored at its top-left grid position. `rowSpan` is always 1 in Phase 1 —
 *  kept in the shape now so Phase 2 (row spans) is an additive change, not a data-model rewrite. */
export interface GridCell {
	row: number;
	col: number;
	rowSpan: number;
	colSpan: number;
	text: string;
}

/** A parsed grid table: `cells` fully tiles the `rows × cols` grid — every grid position belongs
 *  to exactly one cell's span, so there are no separate "empty position" entries to track. */
export interface GridTable {
	indent: string;
	cols: number;
	rows: number;
	hasHeader: boolean;
	aligns: ColumnAlign[];
	cells: GridCell[];
}

export interface GridTableBlock {
	table: GridTable;
	start: number;
	end: number;
}

type BorderSegmentKind = 'dash' | 'eq' | 'blank';
interface BorderSegment {
	kind: BorderSegmentKind;
	leftColon: boolean;
	rightColon: boolean;
}
interface ParsedBorderLine {
	positions: number[];
	segments: BorderSegment[];
}

/** Parse one border line (`+---+---+` / `+===+===+`, optionally `:`-flanked segments for
 *  alignment) into its `+` character offsets and per-segment kind. Returns null for anything
 *  that isn't a well-formed border line — a mixed-character segment, stray characters outside
 *  `+`/`-`/`=`/`:`/space, or fewer than two `+` marks. */
function parseBorderLine(line: string): ParsedBorderLine | null {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith('+') || !trimmed.endsWith('+') || trimmed.length < 2) {
		return null;
	}
	const indentLength = line.length - trimmed.length;
	const positions: number[] = [];
	for (let i = 0; i < trimmed.length; i += 1) {
		if (trimmed[i] === '+') {
			positions.push(indentLength + i);
		}
	}
	if (positions.length < 2) {
		return null;
	}
	const segments: BorderSegment[] = [];
	for (let i = 0; i < positions.length - 1; i += 1) {
		const segText = line.slice(positions[i] + 1, positions[i + 1]);
		if (segText.length === 0) {
			return null;
		}
		if (/^ +$/.test(segText)) {
			segments.push({ kind: 'blank', leftColon: false, rightColon: false });
			continue;
		}
		const leftColon = segText.startsWith(':');
		const rightColon = segText.endsWith(':') && segText.length > 1;
		const core = segText.slice(leftColon ? 1 : 0, segText.length - (rightColon ? 1 : 0));
		if (core.length > 0 && /^-+$/.test(core)) {
			segments.push({ kind: 'dash', leftColon, rightColon });
			continue;
		}
		if (core.length > 0 && /^=+$/.test(core)) {
			segments.push({ kind: 'eq', leftColon, rightColon });
			continue;
		}
		return null;
	}
	return { positions, segments };
}

/** True for a line that parses as SOME kind of border line — used by callers that just need to
 *  know "don't touch this line" without caring about its exact shape. */
export function isGridBorderLine(line: string): boolean {
	return parseBorderLine(line) !== null;
}

function alignFromColons(leftColon: boolean, rightColon: boolean): ColumnAlign {
	if (leftColon && rightColon) {
		return 'center';
	}
	if (leftColon) {
		return 'left';
	}
	if (rightColon) {
		return 'right';
	}
	return null;
}

/** True for a line that at least LOOKS like a grid-table content line — starts and ends with `|`
 *  — without requiring anything about where its OTHER `|` characters fall. This is deliberately
 *  the only test used to decide whether the block-scan keeps going; see this file's header
 *  comment for why position-matching was dropped from that decision entirely. */
function looksLikeContentLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

/** Character indices of every UNESCAPED `|` in `line` (mirrors `splitTableRow`'s own escape
 *  handling) — used only to snap a short band's own cells to specific header columns; never
 *  required to match anything outside this one line. */
function dividerPositions(line: string): number[] {
	const positions: number[] = [];
	for (let i = 0; i < line.length; i += 1) {
		if (line[i] === '|' && line[i - 1] !== '\\') {
			positions.push(i);
		}
	}
	return positions;
}

interface ResolvedCell {
	col: number;
	colSpan: number;
	text: string;
}

/** Recover which ORIGINAL columns a band's `cells.length` (strictly between 1 and `cols`) values
 *  actually span — a genuine partial colspan, not the classic whole-row note — by snapping this
 *  band's own `|` character positions to the nearest of the header's. Tolerant of width drift
 *  (an edited row doesn't need to be pixel-aligned with anything), but returns null — the caller
 *  then pads the shortfall at the end instead, same as a merely-ragged pipe-table row — whenever
 *  the snap can't be resolved unambiguously: the header itself isn't currently a clean columns+1
 *  reference, this band's own boundary count doesn't match its own cell count, or the nearest-
 *  neighbour mapping doesn't come out strictly increasing from column 0 through `cols`. */
function snapBandToColumns(bandFirstLine: string, cellCount: number, headerPositions: number[], cols: number): ResolvedCell[] | null {
	if (headerPositions.length !== cols + 1) {
		return null;
	}
	const bandPositions = dividerPositions(bandFirstLine);
	if (bandPositions.length !== cellCount + 1) {
		return null;
	}
	const mapped = bandPositions.map((p) => {
		let nearest = 0;
		let best = Infinity;
		headerPositions.forEach((hp, i) => {
			const d = Math.abs(hp - p);
			if (d < best) {
				best = d;
				nearest = i;
			}
		});
		return nearest;
	});
	if (mapped[0] !== 0 || mapped[mapped.length - 1] !== cols) {
		return null;
	}
	for (let i = 1; i < mapped.length; i += 1) {
		if (mapped[i] <= mapped[i - 1]) {
			return null; // not strictly increasing — an ambiguous/inconsistent snap
		}
	}
	return mapped.slice(0, -1).map((col, i) => ({ col, colSpan: mapped[i + 1] - col, text: '' }));
}

interface ParsedBand {
	cells: string[];
	firstLine: string;
}

/** Split every physical line of a band via `splitTableRow` and reconcile them into one cell-text
 *  array — a band's natural width is the WIDEST split any of its physical lines produced (a
 *  shorter line pads with '', matching how a wrapped cell's OTHER, un-wrapped cells look on a
 *  continuation line); a multi-line band's cells are the space-joined, trimmed union of every
 *  physical line's own text at that position — the same merge idea `collapseContinuationRows`
 *  uses for pipe tables, just applied within an unambiguous, border-delimited band instead of
 *  inferred from an empty-first-cell heuristic. */
function closeBand(bandLines: string[]): ParsedBand {
	const perLine = bandLines.map((line) => splitTableRow(line));
	const width = Math.max(...perLine.map((cells) => cells.length));
	const merged = new Array<string>(width).fill('');
	for (const cells of perLine) {
		for (let col = 0; col < width; col += 1) {
			const piece = (cells[col] ?? '').trim();
			if (!piece) {
				continue;
			}
			merged[col] = merged[col] ? `${merged[col]} ${piece}` : piece;
		}
	}
	return { cells: merged, firstLine: bandLines[0] };
}

/** Try to parse one grid-table block starting at `lines[start]` (which must itself be a fully
 *  solid top border line). Returns null — never a partial/best-effort result — if the block
 *  never finds a closing border, or a border line signals a row span (unsupported in Phase 1,
 *  see this file's header comment). A malformed BAND (see `closeBand`/`snapBandToColumns`)
 *  degrades gracefully within an otherwise-valid table instead of aborting the whole block — see
 *  this file's header comment for why position-based rejection was replaced with that. Shared by
 *  `scanGridTables` and `computeGridTableBlockLines` so both agree on block extent. */
function tryParseGridTableBlock(lines: string[], start: number): GridTableBlock | null {
	const top = parseBorderLine(lines[start]);
	if (!top || top.segments.some((s) => s.kind !== 'dash' || s.leftColon || s.rightColon)) {
		return null;
	}
	const trimmedTop = lines[start].trimStart();
	const indent = lines[start].slice(0, lines[start].length - trimmedTop.length);

	const bands: ParsedBand[] = [];
	let hasHeader = false;
	let headerEqSegments: BorderSegment[] = [];
	let scan = start + 1;
	let bandLines: string[] = [];
	let closeAt = -1;

	while (scan < lines.length) {
		const border = parseBorderLine(lines[scan]);
		if (border) {
			if (bandLines.length > 0) {
				if (border.segments.some((s) => s.kind === 'blank')) {
					return null; // a row span — unsupported in Phase 1
				}
				bands.push(closeBand(bandLines));
				if (bands.length === 1 && border.segments.some((s) => s.kind === 'eq')) {
					hasHeader = true;
					headerEqSegments = border.segments;
				}
				bandLines = [];
			}
			const after = lines[scan + 1];
			const afterContinues = after !== undefined && (looksLikeContentLine(after) || parseBorderLine(after) !== null);
			if (!afterContinues) {
				closeAt = scan;
				break;
			}
			scan += 1;
			continue;
		}
		if (!looksLikeContentLine(lines[scan])) {
			return null; // neither a border nor a plausible content line — malformed
		}
		bandLines.push(lines[scan]);
		scan += 1;
	}
	if (closeAt === -1 || bands.length === 0) {
		return null;
	}

	const cols = Math.max(...bands.map((band) => band.cells.length));
	const aligns: ColumnAlign[] = hasHeader && headerEqSegments.length === cols ? headerEqSegments.map((s) => alignFromColons(s.leftColon, s.rightColon)) : new Array(cols).fill(null);
	const headerPositions = dividerPositions(bands[0].firstLine);

	const cells: GridCell[] = [];
	bands.forEach((band, rowIndex) => {
		const n = band.cells.length;
		if (n === cols) {
			band.cells.forEach((text, col) => cells.push({ row: rowIndex, col, rowSpan: 1, colSpan: 1, text: text.trim() }));
			return;
		}
		if (n === 1) {
			cells.push({ row: rowIndex, col: 0, rowSpan: 1, colSpan: cols, text: band.cells[0].trim() });
			return;
		}
		const snapped = rowIndex === 0 ? null : snapBandToColumns(band.firstLine, n, headerPositions, cols);
		if (snapped) {
			snapped.forEach((resolved, i) => cells.push({ row: rowIndex, col: resolved.col, rowSpan: 1, colSpan: resolved.colSpan, text: band.cells[i].trim() }));
			return;
		}
		// No reliable snap (a drifted header, an edited band whose own boundary count doesn't
		// match its cell count, or an ambiguous mapping) — treat the shortfall as trailing, same
		// as tables.ts already does for a merely-ragged pipe-table row.
		for (let col = 0; col < cols; col += 1) {
			cells.push({ row: rowIndex, col, rowSpan: 1, colSpan: 1, text: (band.cells[col] ?? '').trim() });
		}
	});

	return {
		table: { indent, cols, rows: bands.length, hasHeader, aligns, cells },
		start,
		end: closeAt + 1,
	};
}

/** Find every grid-table block in `lines`. Fence bodies and MDC blocks are skipped, mirroring
 *  tables.ts's `scanTables`. */
export function scanGridTables(lines: string[]): GridTableBlock[] {
	const blocks: GridTableBlock[] = [];
	const fenceProtected = computeFenceProtectedLines(lines);
	const mdcBlock = computeMdcBlockLines(lines);
	for (let index = 0; index < lines.length; index += 1) {
		if (fenceProtected[index] || mdcBlock[index]) {
			continue;
		}
		if (!lines[index].trimStart().startsWith('+')) {
			continue;
		}
		const block = tryParseGridTableBlock(lines, index);
		if (!block) {
			continue;
		}
		blocks.push(block);
		index = block.end - 1;
	}
	return blocks;
}

/** Flag every line of every grid-table block — the block-skip primitive `reflow.ts` (and
 *  `tables.ts`'s own pipe-table scanner) need so a `+---+---+` border line, which starts with
 *  neither `|` nor any of reflow's other recognized structural markers, never gets glued into
 *  paragraph prose. Mirrors `computeMdcBlockLines`'s shape exactly. */
export function computeGridTableBlockLines(lines: string[]): boolean[] {
	const flagged = new Array<boolean>(lines.length).fill(false);
	for (const block of scanGridTables(lines)) {
		for (let mark = block.start; mark < block.end; mark += 1) {
			flagged[mark] = true;
		}
	}
	return flagged;
}

/** Flatten a GridTable to a plain (non-spanning) `ParsedTable` — the width-0 form, always plain
 *  GFM pipe syntax (see design.md's "Two width regimes"). A cell spanning every column becomes
 *  today's existing single-cell whole-row note (unchanged convention — tables.ts still owns it).
 *  A PARTIAL colspan places its text at the anchor column; the columns it covered stay blank,
 *  never duplicated — a merged value belongs to the group, not to each column individually. This
 *  is a one-way simplification: which cells were merged doesn't survive width 0 (nothing in plain
 *  pipe syntax can carry that), only their content does. */
export function gridToParsedTable(table: GridTable): ParsedTable {
	const { indent, cols, rows, hasHeader, aligns, cells } = table;
	const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(''));
	const wholeRow = new Map<number, string>();
	for (const cell of cells) {
		if (cell.colSpan === cols && cols > 1) {
			wholeRow.set(cell.row, cell.text);
			continue;
		}
		grid[cell.row][cell.col] = cell.text;
	}
	const bodyRowIndices = Array.from({ length: rows }, (_, i) => i).slice(hasHeader ? 1 : 0);
	const bodyRows = bodyRowIndices.map((rowIndex) => (wholeRow.has(rowIndex) ? [wholeRow.get(rowIndex)!] : grid[rowIndex]));
	const header = hasHeader ? grid[0] : new Array<string>(cols).fill('');
	return { indent, aligns, rows: [header, ...bodyRows], cols };
}

/** The inverse conversion — a plain pipe-parsed `ParsedTable` (including its existing arity-1
 *  whole-row-note convention) becomes a `GridTable`: a full-arity row becomes `cols` separate
 *  colSpan-1 cells, and a row with exactly one cell (a sparse/whole-row note, see tables.ts)
 *  becomes a single colSpan-`cols` cell — the two conventions are the same idea, just expressed
 *  differently at each width. */
export function parsedTableToGridTable(table: ParsedTable): GridTable {
	const { indent, aligns, rows, cols } = table;
	const cells: GridCell[] = [];
	rows.forEach((row, rowIndex) => {
		if (row.length === 1 && cols > 1) {
			cells.push({ row: rowIndex, col: 0, rowSpan: 1, colSpan: cols, text: (row[0] ?? '').trim() });
			return;
		}
		for (let col = 0; col < cols; col += 1) {
			cells.push({ row: rowIndex, col, rowSpan: 1, colSpan: 1, text: (row[col] ?? '').trim() });
		}
	});
	return { indent, cols, rows: rows.length, hasHeader: true, aligns, cells };
}

function unspannedProjection(table: GridTable): string[][] {
	const { cols, cells } = table;
	const unspanned: string[][] = [];
	for (const cell of cells) {
		if (cell.colSpan !== 1) {
			continue;
		}
		while (unspanned.length <= cell.row) {
			unspanned.push(new Array<string>(cols).fill(''));
		}
		unspanned[cell.row][cell.col] = cell.text;
	}
	return unspanned;
}

/** Grow `widths` (whatever they started as — this table's own natural widths, or a cross-table
 *  `sharedWidths` array) so every spanning cell has enough room for its own content — evenly
 *  across the columns it covers, remainder to the first few, the same distribution rule tables.ts's
 *  `widenForSparseRows` uses. Always re-applied on TOP of `sharedWidths` (mirroring how
 *  `emitTable` always re-applies `widenForSparseRows` after `sharedWidths` too) — a header-matched
 *  group's shared widths are computed from each table's FLATTENED (span-blanked) projection, so
 *  they never already account for a spanning cell's real content length on their own. */
function widenForGridSpans(widths: number[], table: GridTable): number[] {
	const grown = widths.slice();
	for (const cell of table.cells) {
		if (cell.colSpan === 1) {
			continue;
		}
		const span = Array.from({ length: cell.colSpan }, (_, i) => cell.col + i);
		const dividerBudget = 3 * (span.length - 1); // the ' | ' each swallowed boundary would cost
		const have = span.reduce((sum, c) => sum + grown[c], 0) + dividerBudget;
		const need = cell.text.length;
		if (need > have) {
			const deficit = need - have;
			const share = Math.floor(deficit / span.length);
			const remainder = deficit % span.length;
			span.forEach((c, i) => {
				grown[c] += share + (i < remainder ? 1 : 0);
			});
		}
	}
	return grown;
}

/** Per-column widths for a grid table at `maxLineLength` (0 = natural/unfitted, matching
 *  `computeColumnWidths`'s own convention). Starts from the natural width of every colSpan-1
 *  cell (reusing `computeColumnWidths` verbatim on the unspanned projection), then widens
 *  whatever a spanning cell needs via `widenForGridSpans`. */
function computeGridColumnWidths(table: GridTable, maxLineLength: number, indentLength: number): number[] {
	const { cols } = table;
	const unspanned = unspannedProjection(table);
	const widths = widenForGridSpans(computeColumnWidths(unspanned, cols, 0, indentLength), table);
	const spans = table.cells.filter((c) => c.colSpan > 1).map((c) => ({ cols: Array.from({ length: c.colSpan }, (_, i) => c.col + i), text: c.text }));
	if (maxLineLength <= 0) {
		return widths;
	}
	const floors = new Array(cols).fill(MIN_COLUMN_WIDTH);
	for (const row of unspanned) {
		row.forEach((cellText, col) => {
			for (const token of cellText.split(/\s+/)) {
				floors[col] = Math.max(floors[col], token.length);
			}
		});
	}
	const spanFloors = spans.map((span) => ({ cols: span.cols, floor: Math.max(0, ...span.text.split(/\s+/).map((t) => t.length)) }));
	const totalWidth = (): number => widths.reduce((s, x) => s + x, 0) + widths.length * 3 + 1 + indentLength;
	while (totalWidth() > maxLineLength) {
		let widest = -1;
		let widestWidth = -1;
		for (let col = 0; col < cols; col += 1) {
			if (widths[col] <= floors[col]) {
				continue;
			}
			const wouldBreakSpan = spanFloors.some(({ cols: span, floor }) => {
				if (!span.includes(col)) {
					return false;
				}
				const after = span.reduce((sum, c) => sum + (c === col ? widths[c] - 1 : widths[c]), 0) + 3 * (span.length - 1);
				return after < floor;
			});
			if (wouldBreakSpan) {
				continue;
			}
			if (widths[col] > widestWidth) {
				widestWidth = widths[col];
				widest = col;
			}
		}
		if (widest === -1) {
			break;
		}
		widths[widest] -= 1;
	}
	return widths;
}

/** Emit one grid table at `tableWidth` (always > 0 — see gridToParsedTable for width 0).
 *  `sharedWidths`, when given (a header-matched group — see tables.ts's cross-table matching),
 *  overrides this table's own width computation; spanning tables are excluded from that grouping
 *  upstream (in markdown-format.ts), so this only ever receives widths for a colSpan-1 grid. */
export function emitGridTable(table: GridTable, tableWidth: number, out: string[], sharedWidths?: number[]): void {
	const { indent, cols, rows, hasHeader, aligns, cells } = table;
	const widths = sharedWidths ? widenForGridSpans(sharedWidths, table) : computeGridColumnWidths(table, tableWidth, indent.length);

	const cellsByRow: GridCell[][] = Array.from({ length: rows }, () => []);
	for (const cell of cells) {
		cellsByRow[cell.row].push(cell);
	}
	for (const row of cellsByRow) {
		row.sort((a, b) => a.col - b.col);
	}
	// Which columns does row `r` have a REAL divider before (i.e. not swallowed by a colspan)?
	const dividerCols = (rowIndex: number): Set<number> => {
		const set = new Set<number>([0, cols]);
		for (const cell of cellsByRow[rowIndex]) {
			set.add(cell.col);
			set.add(cell.col + cell.colSpan);
		}
		return set;
	};

	const spanWidth = (cell: GridCell): number => {
		let w = 0;
		for (let c = cell.col; c < cell.col + cell.colSpan; c += 1) {
			w += widths[c];
		}
		return w + 3 * (cell.colSpan - 1);
	};

	// A border between row-band `above` and row-band `below` (either may be null, meaning the
	// table's outer edge, which never forces a merge on its own) shows a real '+' at column
	// boundary `col` only if BOTH adjacent bands have a genuine divider there. If EITHER band
	// spans across `col` (a colspan, or the classic whole-row note), the border omits it — that's
	// what makes the merge visually read as one box instead of a solid grid the content
	// contradicts. This never affects parsing (content lines are authoritative there, see this
	// file's header comment) — it's purely how the border reads to a human.
	const drawBorder = (above: number | null, below: number | null, eq: boolean): string => {
		const aboveDividers = above === null ? null : dividerCols(above);
		const belowDividers = below === null ? null : dividerCols(below);
		let line = indent + '+';
		let col = 0;
		const hasDividerAt = (c: number): boolean => (aboveDividers === null || aboveDividers.has(c)) && (belowDividers === null || belowDividers.has(c));
		while (col < cols) {
			// A segment runs from `col` to the next position where BOTH adjacent bands have a real
			// divider — that's where the '+' goes. `col` itself is always such a position already
			// (the loop only ever stops there), so segments never accidentally merge past a real edge.
			let end = col + 1;
			while (end < cols && !hasDividerAt(end)) {
				end += 1;
			}
			const segCols = Array.from({ length: end - col }, (_, i) => col + i);
			const width = segCols.reduce((s, c) => s + widths[c], 0) + 3 * (segCols.length - 1) + 2;
			const align = eq ? aligns[col] : null;
			const fillChar = eq ? '=' : '-';
			if (align) {
				const leftMark = align === 'left' || align === 'center' ? ':' : fillChar;
				const rightMark = align === 'right' || align === 'center' ? ':' : fillChar;
				line += leftMark + fillChar.repeat(Math.max(width - 2, 0)) + rightMark;
			} else {
				line += fillChar.repeat(width);
			}
			line += '+';
			col = end;
		}
		return line;
	};

	const drawContent = (rowIndex: number): string[] => {
		const rowCells = cellsByRow[rowIndex];
		const wrapped = rowCells.map((cell) => wrapCell(cell.text, spanWidth(cell)));
		const height = Math.max(1, ...wrapped.map((w) => w.length));
		const out2: string[] = [];
		for (let li = 0; li < height; li += 1) {
			let line = indent + '|';
			rowCells.forEach((cell, i) => {
				const text = wrapped[i][li] ?? '';
				line += ` ${text.padEnd(spanWidth(cell), ' ')} |`;
			});
			out2.push(line);
		}
		return out2;
	};

	out.push(drawBorder(null, 0, false));
	out.push(...drawContent(0));
	for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
		out.push(drawBorder(rowIndex - 1, rowIndex, hasHeader && rowIndex === 1));
		out.push(...drawContent(rowIndex));
	}
	out.push(drawBorder(rows - 1, null, false));
}
