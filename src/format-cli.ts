#!/usr/bin/env node
/**
 * format-cli.ts — the `codon-format` CLI: run Codon's markdown formatter outside the editor
 * entirely — from a pre-commit hook, a CI step, a `tasks.json` task, or any other project's build.
 * Vscode-free, plain Node, no workspace dependency. Installed via this package's `bin` entry:
 *
 *     npx @jurijsk/codon-format <file.md ...> [--width N] [--check] [--align-tables-width]
 *     npx @jurijsk/codon-format [--git-driven|--all] [--root <dir>] [--ignore <pattern>]... [--width N] [--check] [--align-tables-width]
 *     # or, once added as a project dependency, drop the `npx @jurijsk/` prefix and use the bin
 *     # name directly: codon-format <file.md ...> ...
 *
 * The `jurijsk.codon` VS Code extension depends on this package and runs the exact same function
 * for every Codon save and Format Document — so `codon-format` and the editor always agree.
 *
 * Rewrites files in place via the same pure text pass (src/markdown-format.ts — no DOM, no
 * editor). `--width 0` (the default) is the logical/commit form: one pipe-aligned line per table
 * row. `--width N` (N ≥ 40) wraps table
 * cell text onto continuation rows so table lines stay under N characters — and `--width 0`
 * losslessly collapses them back, which is the pre-commit normalize step ("commit at width 0").
 * Each file keeps its dominant EOL.
 *
 * `--check` reports without writing — exits 1 if ANY file isn't already canonical AT THE GIVEN
 * WIDTH (0 unless `--width` says otherwise), 0 if every file is clean. It's a general "is this
 * file formatted" gate, not specifically a commit gate — CI is the natural place for it (a PR
 * check shouldn't silently mutate the branch); a LOCAL pre-commit hook more often wants the
 * default auto-fix-and-write form instead, re-staging whatever changed, the way `prettier --write`
 * under lint-staged does. Prints `formatted:` / `unchanged:` (or `would format:` under `--check`).
 *
 * `--align-tables-width` opts in to aligning column widths across tables that share the same
 * structure (exact header match) elsewhere in the document — otherwise each table sizes to only
 * its own content, which is the default.
 *
 * `--git-driven`/`--all` trigger project-wide discovery instead of formatting the positional file
 * arguments — mutually exclusive with each other and with passing explicit paths. See
 * src/discover.ts and docs/project-wide-discovery-spec.md for the full design:
 *   - `--git-driven` delegates to `git ls-files`, respecting `.gitignore`; outside a git working
 *     tree (or if `git` isn't installed), it transparently falls back to `--all`'s behavior,
 *     printing a non-fatal notice rather than erroring.
 *   - `--all` is a plain recursive filesystem walk that never touches git and ignores
 *     `.gitignore` entirely.
 *   - `--root <dir>` sets the discovery root (default: cwd); `--ignore <pattern>` (repeatable)
 *     adds exclusions on top of the two defaults (`.git`, `node_modules`), which are always
 *     merged in and can't be removed.
 *   - `--git-driven` is the default: given no file arguments and neither discovery flag,
 *     `codon-format` runs `--git-driven` from `--root` (cwd unless given) rather than erroring —
 *     printing a notice, since this replaces what used to be a zero-args usage error.
 *
 * Whichever mode: `--width 0` (the default) is the only width safe to COMMIT. `codon.tableWidth`
 * (Ctrl+S / Format Document) legitimately wraps tables wide for on-screen reading, but only
 * Codon's own reader understands that wrapped continuation-row convention — every other GFM
 * renderer (GitHub included) shows it as broken, mostly-empty extra rows. So a hook meant to gate
 * commits should call `--check` with no `--width` (or `--width 0`); the flag stays available for
 * other uses (e.g. checking a file is already wrapped at a specific width) — the CLI trusts the
 * caller here rather than rejecting the combination.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatMarkdown } from './markdown-format.js';
import { discoverGitDriven, discoverAll, DEFAULT_IGNORE, type DiscoveryMode } from './discover.js';

const explicitFiles: string[] = [];
let width = 0;
let check = false;
let alignTablesWidth = false;
let mode: DiscoveryMode | null = null;
let root = '.';
const ignore: string[] = [];

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
	const value = args[index];
	if (value === '--width') {
		const next = args[index + 1];
		if (!next) {
			console.error('Missing value for --width.');
			process.exit(1);
		}
		width = parseWidth(next);
		index += 1;
		continue;
	}
	if (value.startsWith('--width=')) {
		width = parseWidth(value.slice('--width='.length));
		continue;
	}
	if (value === '--check') {
		check = true;
		continue;
	}
	if (value === '--align-tables-width') {
		alignTablesWidth = true;
		continue;
	}
	if (value === '--git-driven' || value === '--all') {
		const requested: DiscoveryMode = value === '--all' ? 'all' : 'git-driven';
		if (mode !== null && mode !== requested) {
			console.error('--git-driven and --all are mutually exclusive.');
			process.exit(1);
		}
		mode = requested;
		continue;
	}
	if (value === '--root') {
		const next = args[index + 1];
		if (!next) {
			console.error('Missing value for --root.');
			process.exit(1);
		}
		root = next;
		index += 1;
		continue;
	}
	if (value === '--ignore') {
		const next = args[index + 1];
		if (!next) {
			console.error('Missing value for --ignore.');
			process.exit(1);
		}
		ignore.push(next);
		index += 1;
		continue;
	}
	explicitFiles.push(value);
}

function parseWidth(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || (parsed !== 0 && parsed < 40)) {
		console.error('--width must be 0 (logical/commit form) or an integer >= 40.');
		process.exit(1);
	}
	return parsed;
}

if (mode !== null && explicitFiles.length > 0) {
	console.error('--git-driven/--all are mutually exclusive with passing explicit file paths.');
	process.exit(1);
}

if (mode === null && explicitFiles.length === 0) {
	console.error(`note: no file arguments or discovery flag given — defaulting to --git-driven from ${root}`);
	mode = 'git-driven';
}

let files: string[];
if (mode !== null) {
	const effectiveIgnore = [...DEFAULT_IGNORE, ...ignore];
	if (mode === 'all') {
		files = discoverAll(root, effectiveIgnore).map((file) => join(root, file));
	} else {
		const gitFiles = discoverGitDriven(root, effectiveIgnore);
		if (gitFiles === null) {
			console.error(`note: ${root} is not a git working tree, falling back to --all`);
			files = discoverAll(root, effectiveIgnore).map((file) => join(root, file));
		} else {
			files = gitFiles.map((file) => join(root, file));
		}
	}
} else {
	files = explicitFiles;
}

if (files.length === 0) {
	// mode is always set by this point (either passed explicitly, or defaulted above) — explicit
	// file args with zero entries is impossible: the only way to reach here with mode === null
	// would require explicitFiles.length > 0, which the default-mode branch above already rules out.
	console.log(`${mode === 'all' ? '--all' : '--git-driven'}: no markdown files found under ${root}.`);
	process.exit(0);
}

let failed = false;
let unformatted = false;
for (const file of files) {
	try {
		const original = readFileSync(file, 'utf8');
		const formatted = formatMarkdown(original, { tableWidth: width, alignTablesWidth });
		if (formatted === original) {
			console.log(`unchanged: ${file} (width=${width === 0 ? '0/logical' : width})`);
			continue;
		}
		if (check) {
			unformatted = true;
			console.log(`would format: ${file} (width=${width === 0 ? '0/logical' : width})`);
			continue;
		}
		writeFileSync(file, formatted, 'utf8');
		console.log(`formatted: ${file} (width=${width === 0 ? '0/logical' : width})`);
	} catch (e) {
		failed = true;
		console.error(`error: ${file} — ${e instanceof Error ? e.message : String(e)}`);
	}
}
if (check && unformatted) {
	console.error('Format issues found in the file(s) above. Run without --check to fix.');
}
process.exit(failed || (check && unformatted) ? 1 : 0);
