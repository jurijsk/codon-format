/**
 * list-tighten.ts — the list-tightening pass: drop blank lines between the items of a SIMPLE list.
 */
import { computeYamlMetadataBlockLines } from './frontmatter';
import { computeMdcBlockLines } from './mdc';

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
 * convergence contract (test/formatParity.test.ts, in the jurijsk.codon repo) pins exactly this:
 * after one format, a Codon round-trip is a fixed point of the formatter.
 *
 * Fence bodies, YAML metadata, and multi-line HTML comments pass through untouched (the same
 * protected regions as reflow.ts).
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
