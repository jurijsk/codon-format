/**
 * markdownTextFormat.ts — Codon's markdown formatter: a PURE text→text pass. No DOM, no editor,
 * no TipTap — plain string processing, adapted from the water project's format-markdown scripts.
 * vscode-free AND DOM-free, so it runs synchronously in the extension host, in the CLI
 * (src/formatMdCli.ts → `npm run format:md`), and under plain-node vitest.
 *
 * THE SINGLE LAYOUT AUTHORITY. The webview's serializer produces semantically-correct markdown;
 * what the raw file LOOKS like is decided here, and only here:
 *   - every Codon save is piped through formatMarkdownText() by the host (markdownEditor.ts)
 *     before it reaches the document;
 *   - Format Document (src/markdownFormatter.ts) and the CLI run the same function;
 *   - the webview is always FED the logical width-0 form (tablesToLogicalRows) — it never sees,
 *     and never thinks about, raw-file layout.
 *
 * The passes: paragraph reflow (one line per paragraph/list item), list tightening (blank lines
 * between simple list items dropped), and the width-aware TABLE engine (below): pipe-aligned
 * padded columns, and — via `tableWidth` (the `codon.tableWidth` setting / CLI `--width`) —
 * water-style set-width fitting, where cell text wraps at whitespace onto continuation rows.
 * A continuation row (empty first cell, text elsewhere) is a RAW-FILE convention: it always
 * collapses back into its logical row before any other table work, so width→0→width round-trips
 * are lossless and the WYSIWYG never models continuation rows as real rows.
 *
 * CONTRACT (pinned in test/markdownTextFormat.test.ts + test/formatParity.test.ts):
 *   1. IDEMPOTENT — format(format(x)) === format(x), at every width.
 *   2. PIPELINE-STABLE — for F = format(x): format(serialize(parse(F))) === F. One save cycle
 *      of a formatted file changes nothing; the parity test drives the REAL parse/serialize
 *      pipeline (src/webview/formatCore.ts, jsdom — tests only) as the oracle.
 *   3. LAYOUT-ONLY — never rewrites inline spelling (emphasis markers, escapes, link encoding,
 *      list renumbering). Those stay the serializer's domain.
 *
 * What passes through verbatim: YAML frontmatter (top-of-file or Pandoc-style mid-document),
 * code fences and their bodies, indented code blocks, headings, blockquotes, thematic breaks /
 * setext underlines, HTML blocks, multi-line HTML comments (byte-for-byte — Codon's comment
 * pills round-trip raw), WHOLE MDC block components (`::name … ::` incl. props and slot —
 * computeMdcBlockLines, mirroring the editor's raw Mdc node) plus bare `:`-directive lines,
 * link reference definitions, and lines ending in a hard break (`\` or two trailing spaces).
 */

export type Eol = '\n' | '\r\n';

/** The EOL a rewritten text should keep: CRLF only when it outnumbers bare LF, so a mostly-LF
 *  file with a few stray CRLFs settles on LF instead of gaining carriage returns everywhere. */
export function dominantEol(text: string): Eol {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? '\r\n' : '\n';
}

/** Re-emit `text` (any mix of EOLs) with a single uniform EOL. */
export function withEol(text: string, eol: Eol): string {
	const lf = text.replace(/\r\n?/g, '\n');
	return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

const LIST_MARKER_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Lines that must never be JOINED to a neighbour (joining a wrapped paragraph cannot split an
 * inline construct, so links/inline code join safely; only these shapes lose meaning):
 *  - a trailing `\` or two trailing spaces — a markdown hard break, which joining would delete;
 *  - a link-reference / footnote definition (`[label]: url`) — pulled into the paragraph above
 *    it stops being a definition;
 *  - a Quarto block shortcode (`{{< include … >}}`) — must stand alone to be treated as a block.
 */
const JOIN_UNSAFE_LINE_RE = /\\$| {2}$|^\s*\[[^\]]+\]:\s|^\s*\{\{</;

/** Collapse whitespace runs to single spaces — except inside `inline code`, where spacing is
 *  content. (The serializer's output likewise has collapsed prose spacing.) */
function normalizeProseSpaces(text: string): string {
	let normalized = '';
	let inInlineCode = false;
	let sawWhitespace = false;
	for (const char of text) {
		if (char === '`') {
			if (sawWhitespace) {
				normalized += ' ';
				sawWhitespace = false;
			}
			inInlineCode = !inInlineCode;
			normalized += char;
			continue;
		}
		if (!inInlineCode && /\s/.test(char)) {
			sawWhitespace = true;
			continue;
		}
		if (sawWhitespace) {
			normalized += ' ';
			sawWhitespace = false;
		}
		normalized += char;
	}
	if (sawWhitespace) {
		normalized += ' ';
	}
	return normalized.trim();
}

/* A YAML mapping key (`key:` / `key: value`) or block-sequence item (`- item`) — the shape a
 * real metadata block opens with; distinguishes frontmatter from a bare `---` thematic break. */
const YAML_KEYISH_RE = /^\s*(?:-\s|[^\s#][^:]*:(?:\s|$))/;

/** Flag every line of a YAML metadata block (top-of-file frontmatter or a Pandoc mid-document
 *  block): `---` opener at file start or after a blank line, a YAML-keyish first body line, and
 *  a `---`/`...` closer. The body is structured data, not prose — it must never be joined. */
export function computeYamlMetadataBlockLines(lines: string[]): boolean[] {
	const flagged = new Array<boolean>(lines.length).fill(false);
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].trim() !== '---') {
			continue;
		}
		if (index !== 0 && lines[index - 1].trim() !== '') {
			continue;
		}
		if (!YAML_KEYISH_RE.test(lines[index + 1] ?? '')) {
			continue;
		}
		let close = -1;
		for (let scan = index + 1; scan < lines.length; scan += 1) {
			const trimmed = lines[scan].trim();
			if (trimmed === '---' || trimmed === '...') {
				close = scan;
				break;
			}
		}
		if (close === -1) {
			continue;
		}
		for (let mark = index; mark <= close; mark += 1) {
			flagged[mark] = true;
		}
		index = close;
	}
	return flagged;
}

/**
 * Flag every line of a well-formed MDC block component (`::name` / `::name{props}` opener
 * through the matching closer — a line of exactly the SAME colons; nested components use MORE
 * colons, so equality is the whole nesting story). Everything inside is the component's raw
 * body (YAML props, slot markdown) and must pass through all three passes byte-for-byte —
 * mirroring the editor's raw-preserving Mdc node (src/webview/mdc.ts), which is what keeps the
 * convergence contract intact. Fence bodies are skipped; an opener with no closer flags
 * nothing (line-level pass-through still applies to the bare `:`-directive line).
 */
export function computeMdcBlockLines(lines: string[]): boolean[] {
	const flagged = new Array<boolean>(lines.length).fill(false);
	let inCode = false;
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trimStart();
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		const match = /^(:{2,})[A-Za-z][\w-]*(\{.*\})?\s*$/.exec(trimmed);
		if (!match) {
			continue;
		}
		let close = -1;
		for (let scan = index + 1; scan < lines.length; scan += 1) {
			if (lines[scan].trim() === match[1]) {
				close = scan;
				break;
			}
		}
		if (close === -1) {
			continue;
		}
		for (let mark = index; mark <= close; mark += 1) {
			flagged[mark] = true;
		}
		index = close;
	}
	return flagged;
}

interface ProseBuffer {
	text: string;
	indent: string;
}

/**
 * The reflow pass: join each wrapped paragraph / list item onto a single line (the serializer's
 * layout), leaving every structural construct untouched. Operates on LF-split lines.
 */
export function reflowLines(lines: string[]): string[] {
	const out: string[] = [];
	const yamlBlock = computeYamlMetadataBlockLines(lines);
	const mdcBlock = computeMdcBlockLines(lines);
	let buffer: ProseBuffer | null = null;
	let inCode = false;
	const flush = (): void => {
		if (!buffer) {
			return;
		}
		out.push(buffer.indent + buffer.text);
		buffer = null;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];

		if (yamlBlock[index] || mdcBlock[index]) {
			flush();
			out.push(line);
			continue;
		}

		const trimmed = line.trimStart();
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			flush();
			inCode = !inCode;
			out.push(line);
			continue;
		}
		if (inCode) {
			out.push(line);
			continue;
		}

		if (line.trim() === '') {
			flush();
			out.push(line);
			continue;
		}

		// Structural lines pass through verbatim and break the paragraph buffer. `:`-initial in
		// one rule covers MDC `:inline`, `::block`, `:::nested` and Quarto `:::` div fences.
		const isHeading = /^#{1,6}\s/.test(trimmed);
		// Thematic break or setext underline: a run of only `-`, `=`, `*`, `_` keeps its own line
		// (never joined onto the paragraph above, which would turn `path ----` into prose).
		const isHrOrSetext = /^(?:-{2,}|={2,}|\*{3,}|_{3,})\s*$/.test(trimmed);
		const isTable = trimmed.startsWith('|');
		const isBlockquote = trimmed.startsWith('>');
		const isHtml = trimmed.startsWith('<');
		const isDirective = trimmed.startsWith(':');
		if (isHeading || isHrOrSetext || isTable || isBlockquote || isHtml || isDirective) {
			flush();
			out.push(line);
			// A multi-line HTML comment is emitted verbatim through its `-->` closer — comment
			// bodies are raw metadata (Codon's pills round-trip them byte-for-byte) and may hold
			// code whose fences sit mid-line, so the fence toggle above must not see them.
			if (trimmed.startsWith('<!--') && !line.includes('-->')) {
				index += 1;
				while (index < lines.length && !lines[index].includes('-->')) {
					out.push(lines[index]);
					index += 1;
				}
				if (index < lines.length) {
					out.push(lines[index]);
				} // the line carrying `-->`
				continue;
			}
			// An MDC block opener (`::name`) may be followed by a `---…---` YAML props block —
			// structured data, emitted verbatim (collapsing it would corrupt the props).
			if (/^:{2,}\w/.test(trimmed) && lines[index + 1]?.trim() === '---') {
				index += 1;
				out.push(lines[index]); // opening `---`
				index += 1;
				while (index < lines.length && lines[index].trim() !== '---') {
					out.push(lines[index]);
					index += 1;
				}
				if (index < lines.length) {
					out.push(lines[index]);
				} // closing `---`
			}
			continue;
		}

		if (JOIN_UNSAFE_LINE_RE.test(line)) {
			flush();
			out.push(line);
			continue;
		}

		// An indented code block (4 spaces / tab at the START of a block — buffer empty means a
		// blank/structural line came before). A ≥4-indented CONTINUATION of a list item is lazy
		// paragraph text and still joins below.
		if (buffer === null && /^(?:\t| {4})/.test(line)) {
			out.push(line);
			continue;
		}

		const listMatch = LIST_MARKER_RE.exec(line);
		if (listMatch) {
			flush();
			const [, indent, marker, rest] = listMatch;
			buffer = { text: normalizeProseSpaces(rest.trim()), indent: `${indent}${marker} ` };
			continue;
		}

		if (buffer) {
			buffer.text = normalizeProseSpaces(`${buffer.text} ${line.trim()}`);
			continue;
		}
		// A fresh prose line: keep its own indentation (e.g. the indented second paragraph of a
		// loose list item — stripping the indent would eject it from the list).
		buffer = { text: normalizeProseSpaces(trimmed), indent: line.slice(0, line.length - trimmed.length) };
	}
	flush();
	return out;
}

/** A list-item line for the tightening pass: marker at any indent, content optional (a bare
 *  `- ` parent whose content is only a nested list is still an item). NOT `---` etc. — a run of
 *  dashes has no space after the first, so it never matches. */
const ITEM_LINE_RE = /^\s*(?:[-*+]|\d+[.)])(?:\s.*)?$/;

/**
 * The list-tightening pass: drop blank lines between the items of a SIMPLE list — one whose
 * every line is itself a list-marker line (any nesting depth, no other content). `- a\n\n- b`
 * renders the same as `- a\n- b`, and once tightened the Codon serializer KEEPS it tight, so
 * the tight layout is the stable canonical one.
 *
 * Lists with block content inside items (an indented continuation paragraph, a code fence, a
 * comment) are left byte-for-byte alone: markdown-it parses any list containing in-item blank
 * lines as LOOSE and Codon's serializer then re-emits blanks between every item — tightening
 * those would put Format Document and the webview write-back in an endless tug-of-war. The
 * convergence contract (test/formatParity.test.ts) pins exactly this: after one format, a Codon
 * round-trip is a fixed point of the formatter.
 *
 * Fence bodies, YAML metadata, and multi-line HTML comments pass through untouched (the same
 * protected regions as reflowLines).
 */
export function tightenListLines(lines: string[]): string[] {
	const out: string[] = [];
	const yamlBlock = computeYamlMetadataBlockLines(lines);
	const mdcBlock = computeMdcBlockLines(lines);
	let inCode = false;
	let inComment = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (yamlBlock[index] || mdcBlock[index]) {
			out.push(line);
			continue;
		}
		if (inComment) {
			out.push(line);
			if (line.includes('-->')) {
				inComment = false;
			}
			continue;
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCode = !inCode;
			out.push(line);
			continue;
		}
		if (inCode) {
			out.push(line);
			continue;
		}
		if (trimmed.startsWith('<!--') && !line.includes('-->')) {
			inComment = true;
			out.push(line);
			continue;
		}
		if (!ITEM_LINE_RE.test(line)) {
			out.push(line);
			continue;
		}

		// A list run starts here. Collect it whole, tracking whether it is SIMPLE (marker lines
		// only) or has block content inside items; then emit tight or verbatim accordingly.
		const runLines: string[] = [];
		let complex = false;
		let scan = index;
		while (scan < lines.length) {
			const current = lines[scan];
			const currentTrimmed = current.trimStart();
			if (yamlBlock[scan] || mdcBlock[scan]) {
				break;
			}
			if (currentTrimmed.startsWith('```') || currentTrimmed.startsWith('~~~')) {
				if (!/^\s/.test(current)) {
					break;
				} // column-0 fence: a new block, not item content
				// An indented fence is item content — consume its body whole (it may hold blank
				// lines and marker-looking lines that must not be treated as list structure).
				complex = true;
				const fenceMark = currentTrimmed.startsWith('```') ? '```' : '~~~';
				runLines.push(current);
				scan += 1;
				while (scan < lines.length && !lines[scan].trimStart().startsWith(fenceMark)) {
					runLines.push(lines[scan]);
					scan += 1;
				}
				if (scan < lines.length) {
					runLines.push(lines[scan]);
					scan += 1;
				}
				continue;
			}
			if (currentTrimmed.startsWith('<!--') && !current.includes('-->')) {
				if (!/^\s/.test(current)) {
					break;
				} // column-0 comment: its own block
				complex = true;
				runLines.push(current);
				scan += 1;
				while (scan < lines.length && !lines[scan].includes('-->')) {
					runLines.push(lines[scan]);
					scan += 1;
				}
				if (scan < lines.length) {
					runLines.push(lines[scan]);
					scan += 1;
				}
				continue;
			}
			if (current.trim() === '') {
				// Blanks belong to the run only if the list continues after them.
				let peek = scan;
				while (peek < lines.length && lines[peek].trim() === '') {
					peek += 1;
				}
				if (peek >= lines.length) {
					break;
				}
				const peeked = lines[peek];
				const peekedTrimmed = peeked.trimStart();
				if (yamlBlock[peek] || mdcBlock[peek]) {
					break;
				}
				if ((peekedTrimmed.startsWith('```') || peekedTrimmed.startsWith('~~~') || peekedTrimmed.startsWith('<!--')) && !/^\s/.test(peeked)) {
					break;
				}
				const continues = ITEM_LINE_RE.test(peeked) || /^\s+\S/.test(peeked);
				if (!continues) {
					break;
				}
				if (ITEM_LINE_RE.test(peeked)) {
					// Not every blank-then-item continues THIS list. At the same (or shallower)
					// indent, a DIFFERENT marker style (`-` vs `*`, `1.` vs `1)`, bullet vs
					// ordered) starts a new list per CommonMark, and a DOUBLE blank is the
					// serializer's own separator between two adjacent same-type lists (without it
					// they'd merge on re-parse). End the run so those blanks survive; only a
					// deeper-indented item is nested content of the current list.
					const lastItem = [...runLines].reverse().find((l) => ITEM_LINE_RE.test(l)) ?? runLines[0];
					const markerStyle = (l: string): string => {
						const m = /^\s*([-*+]|\d+([.)]))/.exec(l);
						return m ? (m[2] ?? m[1]) : '';
					};
					const indentOf = (l: string): number => (/^\s*/.exec(l) as RegExpExecArray)[0].length;
					const sameOrShallower = indentOf(peeked) <= indentOf(lastItem);
					if (sameOrShallower && (peek - scan >= 2 || markerStyle(peeked) !== markerStyle(lastItem))) {
						break;
					}
				} else {
					complex = true; // blank + indented content = loose item body
				}
				for (let k = scan; k < peek; k += 1) {
					runLines.push(lines[k]);
				}
				scan = peek;
				continue;
			}
			if (ITEM_LINE_RE.test(current)) {
				// A BARE marker (`-` with no content — an item holding only a nested block) is a
				// structural shape the serializer emits loose; treat the run as complex so its
				// blanks survive verbatim. Simple checklists always have content after the marker.
				if (/^\s*(?:[-*+]|\d+[.)])\s*$/.test(current)) {
					complex = true;
				}
				runLines.push(current);
				scan += 1;
				continue;
			}
			if (/^\s+\S/.test(current)) {
				complex = true;
				runLines.push(current);
				scan += 1;
				continue;
			}
			break; // non-indented, non-marker → the list ended
		}
		if (complex) {
			for (const runLine of runLines) {
				out.push(runLine);
			}
		} else {
			for (const runLine of runLines) {
				if (runLine.trim() !== '') {
					out.push(runLine);
				}
			}
		}
		index = scan - 1;
	}
	return out;
}

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

// ---------------------------------------------------------------------------
// The table engine — water's width machinery, with two deliberate upgrades: column ALIGNMENT
// (`:---` / `:---:` / `---:`) is preserved (water always writes plain dashes), and ragged rows
// pad out to the widest row instead of losing cells.
// ---------------------------------------------------------------------------

const MIN_COLUMN_WIDTH = 3;
/** The narrowest meaningful set width — below this the shrink loop can't do useful work. */
const MIN_TABLE_WIDTH = 40;
/** Width-0 padding cap: pipes align up to this many characters per column; a monster cell
 *  (key-value dumps run to thousands of chars) overflows its own column instead of forcing
 *  megabytes of alignment spaces onto every other row. */
const MAX_PAD_WIDTH = 80;

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
		widths.push(maxLineLength === 0 ? Math.min(base, MAX_PAD_WIDTH) : base);
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

interface ParsedTable {
	indent: string;
	aligns: ColumnAlign[];
	rows: string[][];
	cols: number;
}

/** Exact header key for cross-table width matching: cell text in order. Two tables with the same
 *  key (same labels, same order) are a "same schema" group — see computeGroupWidths. */
function tableHeaderKey(table: ParsedTable): string {
	return table.rows[0].map((cell) => cell.trim()).join(' ');
}

/** Column widths shared by every table in a header-matched group, computed as if all their rows
 *  (one shared header + every table's body rows, concatenated) were a single table — so the same
 *  column lines up at the same width across every occurrence (e.g. one table per doc section,
 *  repeating the same columns). Callers only invoke this for groups of 2+ tables. */
function computeGroupWidths(tables: ParsedTable[], tableWidth: number): number[] {
	const mergedRows = [tables[0].rows[0], ...tables.flatMap((table) => table.rows.slice(1))];
	const indentLength = Math.max(...tables.map((table) => table.indent.length));
	return computeColumnWidths(mergedRows, tables[0].cols, tableWidth, indentLength);
}

/** Emit one table at the given width: 0 = one padded line per logical row; >0 = cells wrapped
 *  at whitespace onto padded continuation rows (the header never wraps). `sharedWidths`, when
 *  given (a header-matched group), overrides this table's own per-table width computation. */
function emitTable(table: ParsedTable, tableWidth: number, out: string[], sharedWidths?: number[]): void {
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
 *  logical row, no padding — the form the webview is fed. */
function emitLogicalTable(table: ParsedTable, out: string[]): void {
	const { indent, aligns, rows, cols } = table;
	const line = (cells: string[]): string => `${indent}| ${Array.from({ length: cols }, (_, col) => (cells[col] ?? '').trim()).join(' | ')} |`;
	out.push(line(rows[0]));
	out.push(`${indent}| ${aligns.map(minimalDelimiter).join(' | ')} |`);
	for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
		out.push(line(rows[rowIndex]));
	}
}

interface TableBlock {
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
function scanTables(lines: string[]): TableBlock[] {
	const blocks: TableBlock[] = [];
	const mdcBlock = computeMdcBlockLines(lines);
	let inCode = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trimStart();
		if (mdcBlock[index]) {
			continue;
		}
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
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
function emitTableLines(lines: string[], blocks: TableBlock[], emit: (table: ParsedTable, out: string[]) => void): string[] {
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
function transformTableLines(lines: string[], emit: (table: ParsedTable, out: string[]) => void): string[] {
	return emitTableLines(lines, scanTables(lines), emit);
}

export interface FormatMarkdownTextOptions {
	/** Raw-file table width: 0 (default) = one pipe-aligned line per logical row (the logical /
	 *  commit form); ≥40 = wrap cell text at whitespace onto continuation rows so table lines
	 *  stay under this many characters. Values 1–39 are clamped up to 40. */
	tableWidth?: number;
}

/**
 * Format markdown text to Codon's canonical layout. Pure string→string; preserves the input's
 * dominant EOL, so callers pass `document.getText()` / file contents directly and write the
 * result back without EOL bookkeeping.
 */
export function formatMarkdownText(content: string, options: FormatMarkdownTextOptions = {}): string {
	const raw = options.tableWidth ?? 0;
	const tableWidth = raw <= 0 ? 0 : Math.max(raw, MIN_TABLE_WIDTH);
	const lines = tightenListLines(reflowLines(content.split(/\r?\n/)));
	const blocks = scanTables(lines);
	// Tables with an EXACT header match (same labels, same order) share one set of column widths
	// — computed from their rows combined — so the same column lines up at the same width across
	// every occurrence (e.g. one table per doc section, repeating the same schema).
	const groupWidths = new Map<ParsedTable, number[]>();
	const groups = new Map<string, ParsedTable[]>();
	for (const { table } of blocks) {
		const key = tableHeaderKey(table);
		const group = groups.get(key) ?? [];
		group.push(table);
		groups.set(key, group);
	}
	for (const tables of groups.values()) {
		if (tables.length < 2) {
			continue;
		}
		const widths = computeGroupWidths(tables, tableWidth);
		for (const table of tables) {
			groupWidths.set(table, widths);
		}
	}
	const joined = emitTableLines(lines, blocks, (table, out) => emitTable(table, tableWidth, out, groupWidths.get(table))).join('\n');
	// Exactly ONE final newline (the serializer emits none; hand-authored files vary) — a
	// formatter guarantee, and what keeps the save cycle byte-stable on the last byte.
	const trimmed = joined.replace(/\n+$/, '');
	const formatted = trimmed === '' ? '' : `${trimmed}\n`;
	return withEol(formatted, dominantEol(content));
}

/**
 * The LOGICAL (width-0, minimal) form of `content`, touching ONLY tables: continuation rows
 * collapse into their logical rows, cells unpadded — everything else byte-identical. This is
 * what the host feeds the webview (markdownEditor.ts): the WYSIWYG must model logical rows,
 * never the raw file's wrap convention, and the minimal style matches the serializer's own so
 * the webview's echo comparison still works.
 */
export function tablesToLogicalRows(content: string): string {
	const lines = content.split(/\r?\n/);
	return withEol(transformTableLines(lines, emitLogicalTable).join('\n'), dominantEol(content));
}
