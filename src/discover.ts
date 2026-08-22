/**
 * discover.ts — project-wide markdown file discovery: `discoverMarkdownFiles` (this package's
 * library export, re-exported from markdown-format.ts) and the lower-level `discoverGitDriven`/
 * `discoverAll` primitives `format-cli.ts` composes directly so it can print a fallback notice.
 * See ../docs/project-wide-discovery-spec.md for the full design writeup.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The three extensions this ecosystem treats as Codon's domain. */
export const MARKDOWN_EXTENSIONS = ['.md', '.mdc', '.qmd'] as const;

/**
 * Always merged into the effective `--ignore` set, never replaced by it — there's no legitimate
 * reason to ever want either directory's contents formatted. `.git` matters most for
 * `discoverAll`: its plain walk has nothing else stopping it from wastefully descending into
 * `.git/objects/`, `.git/logs/`, etc. if `root` happens to be an actual repo (`discoverGitDriven`
 * would never surface `.git/` paths regardless, so the entry is a harmless no-op there).
 */
export const DEFAULT_IGNORE = ['.git', 'node_modules'];

export type DiscoveryMode = 'git-driven' | 'all';

export interface DiscoverMarkdownFilesOptions {
	/** Directory to discover from. Default: cwd. */
	root?: string;
	/** 'git-driven' (default) delegates to git and respects `.gitignore`, falling back to 'all'
	 *  when `root` isn't a usable git working tree (not a repo, or `git` isn't installed).
	 *  'all' is a plain walk that never touches git and ignores `.gitignore` entirely. */
	mode?: DiscoveryMode;
	/** Extra exclusions, merged with `DEFAULT_IGNORE` — never replacing it. */
	ignore?: string[];
}

/**
 * Root-relative, forward-slash-normalized paths matching `MARKDOWN_EXTENSIONS`. Paths only — no
 * read/write/format side effects, no bundled formatting option: a caller that wants to inspect or
 * discard some of the discovered files before formatting the rest can't do that if discovery and
 * formatting are fused into one call.
 */
export function discoverMarkdownFiles(options: DiscoverMarkdownFilesOptions = {}): string[] {
	const root = options.root ?? '.';
	const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
	if (options.mode === 'all') {
		return discoverAll(root, ignore);
	}
	return discoverGitDriven(root, ignore) ?? discoverAll(root, ignore);
}

/**
 * `git -C root ls-files --cached --others --exclude-standard`, scoped to the three markdown
 * extensions and NUL-separated (so filenames with spaces/non-ASCII survive intact). No
 * `--full-name`: that flag reports paths relative to the repository's top level rather than to
 * `root`, which is the wrong thing whenever `root` is a subdirectory of a larger repo — `-C root`
 * alone already makes git treat `root` as its effective cwd, which is exactly the root-relative
 * paths this contract needs, with no extra flag required.
 *
 * `--ignore` values become `:!<pattern>` pathspec arguments rather than git's `--exclude=`
 * flag — `--exclude=` only filters `--others` (untracked) output, not `--cached` (tracked), so a
 * tracked file matching the pattern would silently survive.
 *
 * Returns `null` — never throws — on ANY failure to get a usable listing: `root` isn't inside a
 * git working tree, or the `git` binary isn't installed at all. Callers fall back to
 * `discoverAll` in either case; there's nothing to distinguish between them for that purpose.
 */
export function discoverGitDriven(root: string, ignore: string[]): string[] | null {
	const pathspecs = [...MARKDOWN_EXTENSIONS.map((ext) => `*${ext}`), ...ignore.map((pattern) => `:!${pattern}`)];
	const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], { encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		return null;
	}
	return result.stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * A plain recursive filesystem walk — never touches git, never consults `.gitignore`. Matches
 * `--ignore` patterns with `matchesIgnore` (below): directory-/file-name and multi-segment-prefix
 * exclusions only — no gitignore dialect, no glob wildcards, no negation.
 */
export function discoverAll(root: string, ignore: string[]): string[] {
	const out: string[] = [];
	walk(root, root, ignore, out);
	return out;
}

function walk(root: string, dir: string, ignore: string[], out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const relPath = relative(root, full).split(sep).join('/');
		if (matchesIgnore(relPath, ignore)) {
			continue;
		}
		const stats = statSync(full);
		if (stats.isDirectory()) {
			walk(root, full, ignore, out);
		} else if (MARKDOWN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
			out.push(relPath);
		}
	}
}

/**
 * A pattern with no `/` matches if any path segment equals it exactly (an unanchored
 * directory/file-name exclusion, e.g. `output`, `tmp`, `node_modules`). A pattern with a `/`
 * matches if the path, or any suffix of the path starting at a segment boundary, equals the
 * pattern or continues past it at another segment boundary (a multi-segment prefix exclusion,
 * e.g. `.meta/debug` — matching `.meta/debug/x.md` but not `.meta/debugger/x.md`). A single
 * trailing `/` on a pattern (the common gitignore directory-only convention) is stripped first.
 */
export function matchesIgnore(relPath: string, patterns: string[]): boolean {
	const segments = relPath.split('/');
	for (const raw of patterns) {
		const pattern = raw.endsWith('/') ? raw.slice(0, -1) : raw;
		if (pattern.length === 0) {
			continue;
		}
		if (!pattern.includes('/')) {
			if (segments.includes(pattern)) {
				return true;
			}
			continue;
		}
		for (let start = 0; start < segments.length; start += 1) {
			const suffix = segments.slice(start).join('/');
			if (suffix === pattern || suffix.startsWith(`${pattern}/`)) {
				return true;
			}
		}
	}
	return false;
}
