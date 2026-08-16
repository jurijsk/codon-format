/**
 * mdc.ts — detects whole MDC block components (`::name … ::`, Nuxt MDC's block-directive syntax)
 * so every other pass leaves them alone: everything inside — YAML props, slot markdown — is the
 * component's raw body and must pass through byte-for-byte, mirroring Codon's own raw-preserving
 * Mdc editor node (the convergence contract that keeps Format Document and the WYSIWYG editor
 * agreeing depends on both sides treating this region identically).
 */

/**
 * Flag every line of a well-formed MDC block component (`::name` / `::name{props}` opener
 * through the matching closer — a line of exactly the SAME colons; nested components use MORE
 * colons, so equality is the whole nesting story). Fence bodies are skipped; an opener with no
 * closer flags nothing (line-level pass-through still applies to the bare `:`-directive line).
 *
 * Multi-line HTML comments are also skipped whole, same as reflow.ts/list-tighten.ts — a dormant
 * Quarto code cell (`<!-- \`\`\`{r} … \`\`\` -->`) embeds a fence marker mid-line inside the
 * comment; without this, that marker still flips the fence-toggle below (`\`\`\` -->`.trimStart()
 * DOES start with the fence), desyncing `inCode` for the rest of the file and silently hiding
 * every MDC block after it.
 */
export function computeMdcBlockLines(lines: string[]): boolean[] {
	const flagged = new Array<boolean>(lines.length).fill(false);
	let inCode = false;
	let inComment = false;
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trimStart();
		if (inComment) {
			if (lines[index].includes('-->')) {
				inComment = false;
			}
			continue;
		}
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		if (trimmed.startsWith('<!--') && !lines[index].includes('-->')) {
			inComment = true;
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
