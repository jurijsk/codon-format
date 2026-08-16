/**
 * reflow.ts — the paragraph-reflow pass: join each wrapped paragraph / list item onto a single
 * line (the serializer's layout), leaving every structural construct untouched.
 */
import { computeYamlMetadataBlockLines } from './frontmatter';
import { computeMdcBlockLines } from './mdc';
import { isFenceMarker, isCommentOpener, isCommentCloser } from './fences';

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
		if (isFenceMarker(trimmed)) {
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
			if (isCommentOpener(trimmed, line)) {
				index += 1;
				while (index < lines.length && !isCommentCloser(lines[index])) {
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
