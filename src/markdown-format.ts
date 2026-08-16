/**
 * markdown-format.ts — the public entry point for `@jurijsk/codon-format`: wires the
 * individual passes into the one function Codon and the CLI both call. Read THIS file to see the
 * SHAPE of the pipeline; each pass's own reasoning lives in its own module:
 *
 *   - eol.ts          — line-ending detection/normalization
 *   - frontmatter.ts  — YAML metadata block detection (so it's never touched by other passes)
 *   - mdc.ts          — MDC block-component detection (same reason)
 *   - reflow.ts       — paragraph/list-item reflow (one line each)
 *   - listTighten.ts  — dropping blank lines between simple list items
 *   - tables.ts       — the GFM table engine: parsing, column widths, wrapping, emission
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
 *   - every Codon save is piped through formatMarkdownText() by Codon's host (markdownEditor.ts,
 *     imported directly — never spawned as a subprocess);
 *   - Codon's Format Document provider (markdownFormatter.ts) and this package's own CLI run the
 *     exact same function — so editor saves, Format Document, and the CLI all agree by
 *     construction;
 *   - Codon's webview is always FED the logical width-0 form (tablesToLogicalRows) — it never
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
import { dominantEol, withEol } from './eol';
import { reflowLines } from './reflow';
import { tightenListLines } from './listTighten';
import { MIN_TABLE_WIDTH, scanTables, emitTableLines, emitTable, emitLogicalTable, transformTableLines, tableHeaderKey, computeGroupWidths, type ParsedTable } from './tables';

export type { Eol } from './eol';
export { dominantEol, withEol } from './eol';
export { computeYamlMetadataBlockLines } from './frontmatter';
export { computeMdcBlockLines } from './mdc';
export { reflowLines } from './reflow';
export { tightenListLines } from './listTighten';
export { splitTableRow, isDelimiterLine } from './tables';

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
 * what Codon's host feeds the webview (markdownEditor.ts): the WYSIWYG must model logical rows,
 * never the raw file's wrap convention, and the minimal style matches the serializer's own so
 * the webview's echo comparison still works.
 */
export function tablesToLogicalRows(content: string): string {
	const lines = content.split(/\r?\n/);
	return withEol(transformTableLines(lines, emitLogicalTable).join('\n'), dominantEol(content));
}
