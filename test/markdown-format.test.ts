/**
 * The SHIPPED markdown formatter (src/markdown-format.ts) — a pure text→text pass, no DOM,
 * exercised here in the plain node environment on purpose: production formatting must never
 * need a browser. Pins the layout contract:
 *
 *   - paragraphs and list items join to single lines; indentation is preserved;
 *   - structural constructs pass through verbatim (frontmatter, fences, indented code, headings,
 *     blockquotes, HR/setext underlines, HTML comments incl. multi-line, MDC directives + props,
 *     link-reference definitions, hard-break lines);
 *   - tables are rewritten to Codon's canonical GFM shape (minimal `| a | b |`, alignment kept,
 *     rows padded to the widest — content never dropped), matching tableSerialize.ts style;
 *   - idempotence; dominant-EOL preservation.
 *
 * The companion contract — Codon-serializer output is a fixed point of this formatter — is
 * pinned against the real pipeline in test/formatParity.test.ts (jsdom, test-only oracle).
 */
import { describe, it, expect } from 'vitest';
import { formatMarkdown, tablesToLogicalRows, dominantEol, withEol, reflowLines, splitTableRow, isDelimiterLine } from '../src/markdown-format.js';

describe('paragraph reflow', () => {
	it('joins a wrapped paragraph to one line', () => {
		expect(formatMarkdown('one two\nthree four\nfive\n')).toBe('one two three four five\n');
	});

	it('collapses in-paragraph whitespace runs but not inside inline code', () => {
		expect(formatMarkdown('a   b `c   d` e\n')).toBe('a b `c   d` e\n');
	});

	it('joins wrapped list items and keeps markers + indentation', () => {
		const src = '- first item\n  wraps here\n- second\n  - nested child\n    also wraps\n';
		expect(formatMarkdown(src)).toBe('- first item wraps here\n- second\n  - nested child also wraps\n');
	});

	it('keeps the indented second paragraph of a loose list item indented', () => {
		const src = '- item\n\n  second para\n  wrapped\n';
		expect(formatMarkdown(src)).toBe('- item\n\n  second para wrapped\n');
	});

	it("drops blank lines between list items (tight lists — the serializer's style)", () => {
		expect(formatMarkdown('- [ ] first check\n\n- [ ] second check\n\n- [ ] third\n')).toBe('- [ ] first check\n- [ ] second check\n- [ ] third\n');
		expect(formatMarkdown('1. one\n\n2. two\n')).toBe('1. one\n2. two\n');
		expect(formatMarkdown('- parent\n\n  - child\n')).toBe('- parent\n  - child\n');
	});

	it('keeps the blank line between an item and its indented continuation paragraph', () => {
		const src = '- item\n\n  second para\n\n- next\n';
		expect(formatMarkdown(src)).toBe('- item\n\n  second para\n\n- next\n');
	});

	it('keeps the blank line between a list and a following non-list block', () => {
		const src = '- last item\n\nplain paragraph\n';
		expect(formatMarkdown(src)).toBe(src);
	});

	it('does not tighten list-looking lines inside code fences or comments', () => {
		const fence = '```\n- a\n\n- b\n```';
		expect(formatMarkdown(`${fence}\n`)).toBe(`${fence}\n`);
		const comment = '<!--\n- a\n\n- b\n-->';
		expect(formatMarkdown(`${comment}\n`)).toBe(`${comment}\n`);
	});

	it('never joins hard-break lines, link definitions, or Quarto shortcodes', () => {
		const src = 'line with break\\\nnext\n\n[ref]: https://example.com\nprose\n\n{{< include x.md >}}\nmore\n';
		const out = formatMarkdown(src);
		expect(out).toContain('line with break\\\nnext');
		expect(out).toContain('[ref]: https://example.com\nprose');
		expect(out).toContain('{{< include x.md >}}\nmore');
	});
});

describe('structural pass-through', () => {
	it('leaves YAML frontmatter verbatim (incl. nested lists)', () => {
		const fm = '---\ntitle: Demo\ntags:\n  - a\n  - b\n---';
		const out = formatMarkdown(`${fm}\n\nwrapped\nbody\n`);
		expect(out.startsWith(fm)).toBe(true);
		expect(out).toContain('wrapped body');
	});

	it('leaves code fences and their bodies verbatim', () => {
		const fence = '```txt\nwrapped line one\nwrapped line two\n```';
		expect(formatMarkdown(`${fence}\n`)).toBe(`${fence}\n`);
	});

	it('leaves indented code blocks verbatim', () => {
		const src = 'para\n\n    code line one\n    code line two\n';
		expect(formatMarkdown(src)).toBe(src);
	});

	it('keeps a multi-line HTML comment byte-for-byte', () => {
		const comment = '<!--\nline one\n  line two, indented\nline three\n-->';
		const out = formatMarkdown(`before\n\n${comment}\n\nafter wrapped\nline\n`);
		expect(out).toContain(comment);
		expect(out).toContain('after wrapped line');
	});

	it('keeps headings, blockquotes, and setext underlines on their own lines', () => {
		const src = '# Head\n\n> quoted\n> more\n\nTitle\n---\n';
		expect(formatMarkdown(src)).toBe(src);
	});

	it("leaves a WHOLE MDC component block verbatim — props AND slot (matches the editor's raw Mdc node)", () => {
		const src = '::card\n---\nsort: true\nsearch: true\n---\nslot text\nwrapped\n::\n\nafter\nwrapping\n';
		const out = formatMarkdown(src);
		expect(out).toContain('::card\n---\nsort: true\nsearch: true\n---\nslot text\nwrapped\n::');
		expect(out).toContain('after wrapping');
	});

	it('does not touch tables or tighten lists inside an MDC block', () => {
		const block = '::data\n|a|b|\n|-|-|\n- one\n\n- two\n::';
		expect(formatMarkdown(`${block}\n`)).toBe(`${block}\n`);
	});

	it('nested components (`:::inner`) stay inside the outer block verbatim', () => {
		const block = '::hero\n:::card\nnested\nlines\n:::\n::';
		expect(formatMarkdown(`${block}\n`)).toBe(`${block}\n`);
	});

	it('an unclosed `::opener` gets line-level pass-through only — following prose still reflows', () => {
		const out = formatMarkdown('::lonely\nprose that\nwraps\n');
		expect(out).toContain('::lonely\n');
		expect(out).toContain('prose that wraps');
	});

	// Not Quarto/R-specific — the fence check never inspects what follows the marker (an info
	// string like `{r}`/`python`/`bash`, or nothing at all), so a fence marker embedded inside an
	// HTML comment desyncs fence tracking identically regardless of language or fence style.
	// `{r}` is the realistic motivating case (a Quarto "dormant cell" — a code chunk commented out
	// so it renders but doesn't execute); these cases pin that the fix isn't scoped to it.
	it.each([
		['R chunk (the original motivating case)', '```{r}\nlibrary(x)\n```'],
		['Python chunk', '```{python}\nimport x\n```'],
		['bash chunk', '```bash\necho hi\n```'],
		['no language tag at all', '```\nanything\n```'],
		['tilde fence instead of backticks', '~~~{r}\nlibrary(x)\n~~~'],
	])('a commented-out fenced code cell (%s) before an MDC block does not desync fence tracking', (_label, fenced) => {
		const src = `<!-- ${fenced} -->\n\n::card\nslot text\nwrapped\n::\n`;
		const out = formatMarkdown(src);
		expect(out).toContain(`<!-- ${fenced} -->`);
		expect(out).toContain('::card\nslot text\nwrapped\n::');
	});
});

describe('table normalization — width 0 (pipe-aligned logical rows)', () => {
	it('rewrites a compact table to pipe-aligned padded columns, alignment preserved', () => {
		const out = formatMarkdown('|A|B|C|\n|:-|:-:|-:|\n|x|y|z|\n');
		expect(out).toBe('| A   | B   | C   |\n| :-- | :-: | --: |\n| x   | y   | z   |\n');
	});

	// tables.ts keeps its own independent fence-toggle (separate from mdc.ts's) — same class of
	// regression, and equally language-agnostic: the embedded fence marker inside the HTML comment
	// must not flip it, or every table for the rest of the file goes undetected and passes through
	// unpadded. `{r}` is the realistic motivating case (a Quarto "dormant cell"); these cases pin
	// that the fix isn't scoped to it.
	it.each([
		['R chunk (the original motivating case)', '```{r}\nlibrary(x)\n```'],
		['Python chunk', '```{python}\nimport x\n```'],
		['bash chunk', '```bash\necho hi\n```'],
		['no language tag at all', '```\nanything\n```'],
		['tilde fence instead of backticks', '~~~{r}\nlibrary(x)\n~~~'],
	])('a commented-out fenced code cell (%s) before a table does not desync scanTables own fence tracking', (_label, fenced) => {
		const src = `<!-- ${fenced} -->\n\n|A|B|\n|-|-|\n|1|2|\n`;
		const out = formatMarkdown(src);
		expect(out).toContain(`<!-- ${fenced} -->`);
		expect(out).toContain('| A   | B   |\n| --- | --- |\n| 1   | 2   |');
	});

	it('pads columns to the widest cell so the pipes align down the page', () => {
		const out = formatMarkdown('| Name | R |\n| --- | --- |\n| Ada Lovelace | x |\n');
		expect(out).toBe('| Name         | R   |\n| ------------ | --- |\n| Ada Lovelace | x   |\n');
	});

	it('pads ragged rows to the widest row instead of dropping cells', () => {
		const out = formatMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n');
		expect(out).toBe('| A   | B   |     |\n| --- | --- | --- |\n| 1   | 2   | 3   |\n');
	});

	it('honours escaped pipes inside cells', () => {
		const out = formatMarkdown('| H |\n| --- |\n| a \\| b |\n');
		expect(out).toContain('| a \\| b |');
	});

	it('does not touch pipe-lines inside code fences', () => {
		const fence = '```\n|A|B|\n|-|-|\n```';
		expect(formatMarkdown(`${fence}\n`)).toBe(`${fence}\n`);
	});

	it('splitTableRow / isDelimiterLine parse edge shapes', () => {
		expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
		expect(splitTableRow('|a|b|')).toEqual(['a', 'b']);
		expect(isDelimiterLine('| - | :-: |')).toBe(true);
		expect(isDelimiterLine('| x | --- |')).toBe(false);
	});
});

describe('table width fitting (codon.tableWidth / --width) and the logical form', () => {
	const wide = '| Key | Description |\n| :-- | --- |\n| alpha | a fairly long description that certainly needs to wrap onto several continuation rows |\n';

	it('width N wraps cell text at whitespace into a grid table; lines stay under N', () => {
		const out = formatMarkdown(wide, { tableWidth: 44 });
		const tableLines = out.trimEnd().split('\n');
		expect(tableLines.length).toBeGreaterThan(3); // wrapped content lines exist
		for (const line of tableLines) {
			expect(line.length).toBeLessThanOrEqual(44);
		}
		// Grid-table borders, not GFM pipe syntax.
		expect(tableLines[0]).toMatch(/^\+-+\+-+\+$/);
		// A content line whose Key column is blank (padding) while Description keeps wrapping.
		expect(tableLines.some((l) => /^\|\s+\| \S/.test(l))).toBe(true);
		// Alignment survives the fit, carried on the header-separator border's colons.
		expect(out).toContain('+:');
	});

	it('the header never wraps (its column floors at the full header cell)', () => {
		const out = formatMarkdown(wide, { tableWidth: 44 });
		const tableLines = out.trimEnd().split('\n');
		expect(tableLines[1]).toContain('Description'); // line 0 is the top border
	});

	it('wrap → collapse is LOSSLESS: formatting back at width 0 restores the logical table', () => {
		const atZero = formatMarkdown(wide, { tableWidth: 0 });
		const atWidth = formatMarkdown(wide, { tableWidth: 44 });
		expect(formatMarkdown(atWidth, { tableWidth: 0 })).toBe(atZero);
	});

	it('tablesToLogicalRows collapses continuation rows to minimal one-line rows and touches nothing else', () => {
		const atWidth = formatMarkdown(`intro prose\nthat stays wrapped here\n\n${wide}`, { tableWidth: 44 });
		const logical = tablesToLogicalRows(atWidth);
		// Prose is NOT reflowed by the logical feed (it only touches tables)…
		expect(logical).toContain('intro prose that stays wrapped here'); // already joined by the width format
		// …and the table is back to one minimal line per logical row.
		expect(logical).toContain('| alpha | a fairly long description that certainly needs to wrap onto several continuation rows |');
		expect(logical).toContain('| :--- | --- |');
	});

	it('widths 1–39 clamp up to 40', () => {
		expect(formatMarkdown(wide, { tableWidth: 10 })).toBe(formatMarkdown(wide, { tableWidth: 40 }));
	});

	it('width-0 padding has no cap — every row pads out to a monster cell so pipes stay aligned', () => {
		const monster = 'x'.repeat(300);
		const out = formatMarkdown(`| K | V |\n| --- | --- |\n| a | ${monster} |\n| b | short |\n`);
		const lines = out.trimEnd().split('\n');
		// All four lines are the same length — the short rows pad out to the monster's width.
		expect(lines[0].length).toBe(lines[2].length);
		expect(lines[3].length).toBe(lines[2].length);
		// The monster row keeps its full content.
		expect(lines[2]).toContain(monster);
	});

	it("cells keep <br> bytes verbatim (line breaks are the editor's concern, not the formatter's)", () => {
		const out = formatMarkdown('| K | V |\n| --- | --- |\n| a | x<br>y |\n');
		expect(out).toContain('x<br>y');
	});

	it('format(format(x)) === format(x) at a set width (idempotence holds at every width)', () => {
		const once = formatMarkdown(wide, { tableWidth: 44 });
		expect(formatMarkdown(once, { tableWidth: 44 })).toBe(once);
	});
});

describe('sparse rows (GFM row-spanning-note convention — no real colspan in pipe tables)', () => {
	const commentSrc =
		'| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| Comment: a note that spans the whole row |\n| Lymphocyte % | 52.6 | H |\n';

	it('a row with fewer cells than the header keeps its own cell count instead of being padded', () => {
		const out = formatMarkdown(commentSrc);
		const commentLine = out.trimEnd().split('\n').find((line) => line.includes('Comment:'));
		expect(commentLine).toBe('| Comment: a note that spans the whole row |');
	});

	it('a row missing only its LAST column (2..cols-1 cells) is padded like an ordinary ragged row, not treated as a spanning note', () => {
		const src =
			'| Vital Sign | Reading | Time Taken |\n| --- | --- | --- |\n| Pulse | 79 | 03/23/2026 |\n| Inhaled Oxygen Concentration | - | - |\n| Weight | 58.5 kg | 03/23/2026 |\n';
		const out = formatMarkdown(src);
		expect(out).toBe(
			'| Vital Sign                   | Reading | Time Taken |\n' +
				'| ---------------------------- | ------- | ---------- |\n' +
				'| Pulse                        | 79      | 03/23/2026 |\n' +
				'| Inhaled Oxygen Concentration | -       | -          |\n' +
				'| Weight                       | 58.5 kg | 03/23/2026 |\n',
		);
		// Column 0 (29 chars, "Inhaled Oxygen Concentration") drove every row's width — proof it
		// participated in column-width computation like an ordinary row, not a sparse note.
		const lines = out.trimEnd().split('\n');
		expect(new Set(lines.map((l) => l.length)).size).toBe(1);
	});

	it("a sparse row wraps at the table's full width when it's longer than the target, not confined to one column", () => {
		const longNote = 'Comment: ' + 'word '.repeat(20).trim();
		const src = `| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| ${longNote} |\n| Lymphocyte % | 52.6 | H |\n`;
		const out = formatMarkdown(src, { tableWidth: 44 });
		const lines = out.trimEnd().split('\n');
		expect(lines.every((l) => l.length <= 44)).toBe(true); // wrapped to fit, not left overflowing
		expect(lines.some((l) => l.startsWith('| Comment:'))).toBe(true); // wraps as its own one-cell rows, still starting mid-sentence
		expect(new Set(lines.map((l) => l.length)).size).toBe(1); // every wrapped piece still pads out — pipes stay aligned with the rest of the table
		// Folds back into the exact original sentence when collapsed at width 0.
		expect(formatMarkdown(out, { tableWidth: 0 })).toContain(`| ${longNote} |`);
	});

	it('when tableWidth leaves enough headroom, a sparse row renders on ONE line instead of wrapping unnecessarily tighter than it has to', () => {
		const note = 'Comment: a moderately long note that needs some room but still fits easily';
		const src = `| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| ${note} |\n| Lymphocyte % | 52.6 | H |\n`;
		const out = formatMarkdown(src, { tableWidth: 100 }); // generous cap: bigger than the note needs, not just bigger than the natural table
		const lines = out.trimEnd().split('\n');
		expect(lines.filter((l) => l.includes('Comment:')).length).toBe(1); // one line, not wrapped
		expect(lines.every((l) => l.length <= 100)).toBe(true);
		expect(new Set(lines.map((l) => l.length)).size).toBe(1); // real columns widened to meet it, not left mismatched
	});

	it("a sparse row widens the real columns evenly so every row's trailing pipe still lines up", () => {
		const out = formatMarkdown(commentSrc);
		const lines = out.trimEnd().split('\n');
		expect(new Set(lines.map((l) => l.length)).size).toBe(1); // one shared line length, incl. the sparse row
		expect(lines[0]).toBe('| Component         | Value     | Flag     |');
		expect(lines[2]).toBe('| Neutrophil %      | 27.4      | L        |');
	});

	it("a sparse row narrower than the table just pads out to match, real columns untouched", () => {
		const out = formatMarkdown('| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| N/A |\n| Lymphocyte % | 52.6 | H |\n');
		const lines = out.trimEnd().split('\n');
		expect(new Set(lines.map((l) => l.length)).size).toBe(1);
		expect(lines[0]).toBe('| Component    | Value | Flag |'); // unwidened — the comment is the short one here
		expect(lines[3]).toBe('| N/A                         |');
	});

	it('at a nonzero tableWidth, a long sparse row wraps to fit instead of widening the real columns past the target', () => {
		const longNote = 'Comment: ' + 'word '.repeat(30).trim(); // far longer than any fitted table at width 44
		const src = `| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| ${longNote} |\n| Lymphocyte % | 52.6 | H |\n`;
		const out = formatMarkdown(src, { tableWidth: 44 });
		const lines = out.trimEnd().split('\n');
		expect(lines.every((l) => l.length <= 44)).toBe(true); // nothing — real rows or the sparse row's wrapped pieces — exceeds the target
		expect(formatMarkdown(out, { tableWidth: 0 })).toContain(`| ${longNote} |`); // still one sentence once collapsed
	});

	it('wrap (width N) → collapse (width 0) round-trips a sparse row losslessly', () => {
		const atZero = formatMarkdown(commentSrc, { tableWidth: 0 });
		const atWidth = formatMarkdown(commentSrc, { tableWidth: 44 });
		expect(formatMarkdown(atWidth, { tableWidth: 0 })).toBe(atZero);
	});

	it('a sparse row long enough to wrap folds back into exactly one row at width 0, not phantom extras', () => {
		const longNote = 'Comment: ' + 'word '.repeat(30).trim();
		const src = `| Component | Value | Flag |\n| --- | --- | --- |\n| Neutrophil % | 27.4 | L |\n| ${longNote} |\n| Lymphocyte % | 52.6 | H |\n`;
		const atWidth = formatMarkdown(src, { tableWidth: 44 });
		const atZero = formatMarkdown(src, { tableWidth: 0 });
		expect(atWidth.trimEnd().split('\n').length).toBeGreaterThan(atZero.trimEnd().split('\n').length); // it did actually wrap into more physical lines
		expect(formatMarkdown(atWidth, { tableWidth: 0 })).toBe(atZero); // and they fold straight back
	});

	it('format(format(x)) === format(x) for a sparse row at a set width', () => {
		const once = formatMarkdown(commentSrc, { tableWidth: 44 });
		expect(formatMarkdown(once, { tableWidth: 44 })).toBe(once);
	});
});

describe('grid tables (width N — see grid-tables.ts / docs/design.md)', () => {
	const wide = '| Key | Description |\n| :-- | --- |\n| alpha | a fairly long description that certainly needs to wrap onto several continuation rows |\n';

	it('width 0 always stays plain GFM pipe syntax, width N always emits a grid table', () => {
		expect(formatMarkdown(wide, { tableWidth: 0 })).not.toContain('+');
		expect(formatMarkdown(wide, { tableWidth: 44 }).split('\n')[0]).toMatch(/^\+-+\+-+\+$/);
	});

	it('a full-row-spanning note renders as one merged box (no internal border), and round-trips losslessly', () => {
		const src = '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| Comment: this note spans the whole row |\n| 4 | 5 | 6 |\n';
		const out = formatMarkdown(src, { tableWidth: 44 });
		const lines = out.trimEnd().split('\n');
		const commentBorderAbove = lines[lines.findIndex((l) => l.includes('Comment:')) - 1];
		const commentBorderBelow = lines[lines.findIndex((l) => l.includes('Comment:')) + 1];
		expect(commentBorderAbove).toMatch(/^\+-+\+$/); // one continuous run, no internal '+'
		expect(commentBorderBelow).toMatch(/^\+-+\+$/);
		expect(formatMarkdown(out, { tableWidth: 0 })).toBe(formatMarkdown(src, { tableWidth: 0 }));
	});

	it('a partial colspan (spans some but not all columns) parses, round-trips, and flattens correctly at width 0', () => {
		// Precisely character-aligned (as this tool's own emitter would produce) — a hand-typed
		// grid table one character off is a known Phase-1 rough edge, see docs/design.md.
		const grid = '+--------+--------+-----+\n| A      | B      | C   |\n+========+========+=====+\n| x1     | x2     | x3  |\n+-----------------+-----+\n| merged AB value | y3  |\n+-----------------+-----+\n';
		const out = formatMarkdown(grid, { tableWidth: 40 });
		expect(formatMarkdown(out, { tableWidth: 40 })).toBe(out); // idempotent
		const spanBorder = out.split('\n')[4];
		expect(spanBorder.match(/\+/g)?.length).toBe(3); // A/B boundary merged away; start, C's own boundary, and end remain
		const flat = formatMarkdown(grid, { tableWidth: 0 });
		const lines = flat.trimEnd().split('\n');
		// Flattened: anchor cell's text at column A, column B left blank, C keeps its own value.
		expect(lines.some((l) => /\|\s*merged AB value\s*\|\s*\|\s*y3\s*\|/.test(l))).toBe(true);
	});

	it("column 0 wrapping stays within ONE row-band (the bug this architecture fixes) and round-trips losslessly", () => {
		const src = '| Vital Sign | Reading |\n| --- | --- |\n| Inhaled Oxygen Concentration | - |\n| Weight | 58.5 kg |\n';
		const out = formatMarkdown(src, { tableWidth: 40 });
		const lines = out.trimEnd().split('\n');
		// No border line sits between "Inhaled" and "Concentration" — they're one wrapped row-band.
		const oxygenLineIndex = lines.findIndex((l) => l.includes('Inhaled'));
		expect(lines[oxygenLineIndex + 1]).not.toMatch(/^\+/);
		expect(formatMarkdown(out, { tableWidth: 0 })).toBe(formatMarkdown(src, { tableWidth: 0 }));
		expect(formatMarkdown(out, { tableWidth: 40 })).toBe(out); // idempotent
	});

	it('editing one row (widening its text without touching its borders) still reformats that row AND every row below it', () => {
		// Simulates a human hand-edit: only the "Inhaled Oxygen Concentration" row's own borders
		// were updated (by hand, imperfectly) to fit its new text; nothing else in the table was
		// touched. A position-anchored parser used to stop reading correctly right at this row.
		const src =
			'+----------------+---------------------+------------+\n' +
			'| Vital Sign     | Reading             | Time Taken |\n' +
			'+================+=====================+============+\n' +
			'| Blood Pressure | 118/65              | 03/23/2026 |\n' +
			'+----------------+---------------------+------------+\n' +
			'| Inhaled Oxygen Concentration   | -                   | -          |\n' +
			'+--------------+---------------------+------------+\n' +
			'| Weight       | 58.5 kg (129 lb)    | 03/23/2026 |\n' +
			'+--------------+---------------------+------------+\n';
		const out = formatMarkdown(src, { tableWidth: 80 });
		const lines = out.trimEnd().split('\n');
		expect(new Set(lines.map((l) => l.length)).size).toBe(1); // one consistent width, top to bottom
		expect(lines.some((l) => l.includes('Inhaled Oxygen Concentration'))).toBe(true);
		expect(lines.some((l) => l.includes('Weight'))).toBe(true); // the row BELOW the edit also reformatted
		expect(formatMarkdown(out, { tableWidth: 80 })).toBe(out); // idempotent
	});

	it("reflow.ts doesn't corrupt a grid table's border lines (they don't start with '|')", () => {
		const doc = 'intro text\nthat continues\n\n' + '+-----+-----+\n| A   | B   |\n+=====+=====+\n| x   | y   |\n+-----+-----+\n' + '\nmore prose\nthat continues\n';
		const out = reflowLines(doc.split('\n')).join('\n');
		expect(out).toContain('+-----+-----+');
		expect(out).toContain('+=====+=====+');
		expect(out).toContain('intro text that continues');
	});

	it('a row-span border marker (unsupported in Phase 1) leaves the whole block untouched rather than misreading it', () => {
		const grid = '+-----+-----+\n| A   | B   |\n+=====+=====+\n| x   |     | y1  |\n+     +-----+\n|     | y2  |\n+-----+-----+\n';
		// deliberately malformed-for-phase-1 input; the formatter must not crash or corrupt it
		expect(() => formatMarkdown(grid, { tableWidth: 40 })).not.toThrow();
	});

	it('cross-table width matching still shares column widths through the grid engine', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const out = formatMarkdown(doc, { tableWidth: 44, alignTablesWidth: true });
		const tables = out.split('\n\n');
		expect(tables[0].split('\n')[0]).toBe(tables[1].split('\n')[0]); // same top border on both
	});

	it('format(format(x)) === format(x) for a grid table at a set width', () => {
		const once = formatMarkdown(wide, { tableWidth: 44 });
		expect(formatMarkdown(once, { tableWidth: 44 })).toBe(once);
	});
});

describe('cross-table width matching (tables with an identical header share column widths)', () => {
	it('by default, a narrow table and a wide table with the same header each size to their own content', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n' + '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const out = formatMarkdown(doc);
		const tables = out.split('\n\n');
		expect(tables[0].split('\n')[0]).not.toBe(tables[1].split('\n')[0]);
		expect(tables[0]).toContain('| A    | x    |');
	});

	it('alignTablesWidth: true opts in — a narrow table and a wide table with the same header both pad to the wider one', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n' + '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const out = formatMarkdown(doc, { alignTablesWidth: true });
		const tables = out.split('\n\n');
		// Both tables' header/delimiter lines are byte-identical — same widths, not each fit to
		// its own narrowest content.
		expect(tables[0].split('\n')[0]).toBe(tables[1].split('\n')[0]);
		expect(tables[0].split('\n')[1]).toBe(tables[1].split('\n')[1]);
		expect(tables[0]).toContain('| A          | x                  |');
	});

	it('tables with a different header are NOT matched even with alignTablesWidth: true — each keeps its own width', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n\n' + '| Name | Other |\n| --- | --- |\n| A | x |\n';
		const out = formatMarkdown(doc, { alignTablesWidth: true });
		const tables = out.split('\n\n');
		expect(tables[0].split('\n')[0]).not.toBe(tables[1].split('\n')[0]);
		expect(tables[1]).toContain('| Name | Other |');
	});

	it('with alignTablesWidth: true, a group of 3+ matching tables all share the widest column from any of them', () => {
		const row = (name: string, note: string): string => `| Name | Note |\n| --- | --- |\n| ${name} | ${note} |\n`;
		const doc = [row('A', 'x'), row('B', 'y'), row('Widest Name Here', 'z')].join('\n');
		const out = formatMarkdown(doc, { alignTablesWidth: true });
		const headerLine = out.split('\n')[0];
		for (const line of out.trimEnd().split('\n')) {
			if (line.startsWith('| Name') || /^\| [ABW]/.test(line)) {
				expect(line.length).toBe(headerLine.length);
			}
		}
	});

	it('sharing widths is idempotent: format(format(x)) === format(x)', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n' + '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const once = formatMarkdown(doc, { alignTablesWidth: true });
		expect(formatMarkdown(once, { alignTablesWidth: true })).toBe(once);
	});

	it('a matching header still respects tableWidth wrapping — shared widths, still wrapped', () => {
		const doc =
			'| Key | Description |\n| :-- | --- |\n| a | short |\n\n' +
			'| Key | Description |\n| :-- | --- |\n| alpha | a fairly long description that certainly needs to wrap onto several continuation rows |\n';
		const out = formatMarkdown(doc, { tableWidth: 44, alignTablesWidth: true });
		for (const line of out.trimEnd().split('\n')) {
			if (line.length > 0) {
				expect(line.length).toBeLessThanOrEqual(44);
			}
		}
		// Both tables' header line is byte-identical (short table's Key column was padded to
		// match the wide table's, not fit to its own narrower content).
		const headerLines = out
			.trimEnd()
			.split('\n')
			.filter((line) => line.startsWith('| Key'));
		expect(headerLines).toHaveLength(2);
		expect(headerLines[0]).toBe(headerLines[1]);
	});
});

describe('idempotence & EOL', () => {
	const kitchenSink = [
		'---',
		'title: T',
		'---',
		'',
		'# Head',
		'',
		'wrapped',
		'paragraph with `code` and a [link](x.md)',
		'',
		'- item',
		'  wraps',
		'',
		'| A | B |',
		'| --- | --- |',
		'| 1 | 2 |',
		'',
		'```js',
		'const x = 1;',
		'```',
		'',
		'<!-- a comment -->',
		'',
	].join('\n');

	it('format ∘ format = format', () => {
		const once = formatMarkdown(kitchenSink);
		expect(formatMarkdown(once)).toBe(once);
	});

	it('preserves the dominant EOL', () => {
		expect(formatMarkdown('a b\r\nc d\r\n')).toBe('a b c d\r\n');
		expect(formatMarkdown('a b\nc d\n')).toBe('a b c d\n');
	});

	it('dominantEol picks CRLF only when it outnumbers bare LF', () => {
		expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n');
		expect(dominantEol('a\nb\nc\r\n')).toBe('\n');
		expect(dominantEol('no newlines')).toBe('\n');
	});

	it('withEol re-emits uniformly', () => {
		expect(withEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc');
		expect(withEol('a\r\nb\nc', '\n')).toBe('a\nb\nc');
	});

	it('reflowLines is exposed for reuse and leaves blank-line structure alone', () => {
		expect(reflowLines(['a', 'b', '', 'c'])).toEqual(['a b', '', 'c']);
	});
});
