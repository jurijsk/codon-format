/**
 * frontmatter.ts — detects YAML metadata blocks (top-of-file frontmatter, or a Pandoc-style
 * mid-document block) so every other pass can leave them alone: the body is structured data, not
 * prose, and must never be joined (reflow.ts), tightened (list-tighten.ts), or have its
 * table-looking lines touched (tables.ts).
 */

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
