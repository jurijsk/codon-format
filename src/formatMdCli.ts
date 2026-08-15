#!/usr/bin/env node
/**
 * formatMdCli.ts — the `codon-format` CLI: run Codon's markdown formatter outside the editor
 * entirely — from a pre-commit hook, a CI step, a `tasks.json` task, or any other project's build.
 * Vscode-free, plain Node, no workspace dependency. Installed via this package's `bin` entry:
 *
 *     npx @jurijsk/codon-format <file.md ...> [--width N] [--check]
 *     # or, once added as a project dependency:
 *     codon-format <file.md ...> [--width N] [--check]
 *
 * The `jurijsk.codon` VS Code extension depends on this package and runs the exact same function
 * for every Codon save and Format Document — so `codon-format` and the editor always agree.
 *
 * Rewrites files in place via the same pure text pass (src/markdownTextFormat.ts — no DOM, no
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
 * Whichever mode: `--width 0` (the default) is the only width safe to COMMIT. `codon.tableWidth`
 * (Ctrl+S / Format Document) legitimately wraps tables wide for on-screen reading, but only
 * Codon's own reader understands that wrapped continuation-row convention — every other GFM
 * renderer (GitHub included) shows it as broken, mostly-empty extra rows. So a hook meant to gate
 * commits should call `--check` with no `--width` (or `--width 0`); the flag stays available for
 * other uses (e.g. checking a file is already wrapped at a specific width) — the CLI trusts the
 * caller here rather than rejecting the combination.
 */
import { readFileSync, writeFileSync } from 'fs';
import { formatMarkdownText } from './markdownTextFormat';

const files: string[] = [];
let width = 0;
let check = false;

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
	files.push(value);
}

function parseWidth(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || (parsed !== 0 && parsed < 40)) {
		console.error('--width must be 0 (logical/commit form) or an integer >= 40.');
		process.exit(1);
	}
	return parsed;
}

if (files.length === 0) {
	console.error("Usage: codon-format <file.md ...> [--width 0|N>=40] [--check]   (rewrites files in place to Codon's canonical layout; --check reports without writing)");
	process.exit(1);
}

let failed = false;
let unformatted = false;
for (const file of files) {
	try {
		const original = readFileSync(file, 'utf8');
		const formatted = formatMarkdownText(original, { tableWidth: width });
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
