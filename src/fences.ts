/**
 * fences.ts — shared primitives for fenced code blocks and multi-line HTML comments: the two
 * region types every other pass must skip over IDENTICALLY. Centralized here once instead of
 * reimplemented per pass — a hand-typed `'<!--'` / `` '```' `` literal duplicated across four
 * files is exactly how the same fence/comment-desync bug (0.2.3) turned up independently in both
 * mdc.ts and tables.ts: one file got the comment guard, the other didn't, and nothing made that
 * drift visible until a real document hit it.
 */

/** The two fence marker spellings GFM recognizes. */
export const FENCE_TICKS = '```';
export const FENCE_TILDES = '~~~';
/** HTML comment delimiters. */
export const COMMENT_OPEN = '<!--';
export const COMMENT_CLOSE = '-->';

/** True for a fence-open/close marker line (``` or ~~~), given its LEADING-WHITESPACE-TRIMMED text. */
export function isFenceMarker(trimmed: string): boolean {
	return trimmed.startsWith(FENCE_TICKS) || trimmed.startsWith(FENCE_TILDES);
}

/** True for a line STARTING with the HTML comment opener, regardless of whether it also closes on
 *  the same line — narrower than `isCommentOpener`, for callers that just need "is this comment-like". */
export function isCommentMarker(trimmed: string): boolean {
	return trimmed.startsWith(COMMENT_OPEN);
}

/** True for a line that OPENS a multi-line HTML comment: starts `<!--`, no `-->` on the same line. */
export function isCommentOpener(trimmed: string, line: string): boolean {
	return isCommentMarker(trimmed) && !isCommentCloser(line);
}

/** True for a line that closes a currently-open multi-line HTML comment. */
export function isCommentCloser(line: string): boolean {
	return line.includes(COMMENT_CLOSE);
}

/**
 * Flag every line that sits inside a fenced code block OR a multi-line HTML comment (fence/comment
 * marker lines included) — the two region types no other pass may look inside. The comment case is
 * consumed atomically: once a comment opener is seen, every line through its closer is flagged
 * without ever re-testing them against the fence check — a fence marker embedded mid-line inside a
 * comment (a dormant Quarto cell, `<!-- \`\`\`{r} … \`\`\` -->`) must never flip the fence toggle.
 */
export function computeFenceProtectedLines(lines: string[]): boolean[] {
	const flagged = new Array<boolean>(lines.length).fill(false);
	let inCode = false;
	let inComment = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (inComment) {
			flagged[index] = true;
			if (isCommentCloser(line)) {
				inComment = false;
			}
			continue;
		}
		const trimmed = line.trimStart();
		if (isFenceMarker(trimmed)) {
			inCode = !inCode;
			flagged[index] = true;
			continue;
		}
		if (inCode) {
			flagged[index] = true;
			continue;
		}
		if (isCommentOpener(trimmed, line)) {
			inComment = true;
			flagged[index] = true;
			continue;
		}
	}
	return flagged;
}
