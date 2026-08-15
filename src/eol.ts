/**
 * eol.ts — line-ending helpers shared by every pass. Every pass works on LF-split lines
 * internally; the top-level entry points (markdownTextFormat.ts) re-apply whichever EOL style the
 * input actually used, so a CRLF file stays CRLF and an LF file stays LF.
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
