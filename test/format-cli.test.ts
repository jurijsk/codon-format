/**
 * format-cli.test.ts — exercises the COMPILED CLI (out/format-cli.js) as a subprocess, the same
 * way an external consumer (pre-commit hook, CI step, another project's tasks.json) would call it.
 * Deliberately black-box: no importing the module's internals, since its whole point is to be a
 * standalone, vscode-free executable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// import.meta.dirname, not __dirname: this package is ESM ("type": "module"), where the CJS
// wrapper variables don't exist. Needs Node >= 20.11, which is the `engines.node` floor.
const CLI = join(import.meta.dirname, '..', 'out', 'format-cli.js');
const UNFORMATTED = '| Name | Note |\n| --- | --- |\n| Ada Lovelace | x |\n';
const CANONICAL = '| Name         | Note |\n| ------------ | ---- |\n| Ada Lovelace | x    |\n';

function tempFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'codon-cli-test-'));
	const file = join(dir, 'doc.md');
	writeFileSync(file, content, 'utf8');
	return file;
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
		return { status: 0, stdout, stderr: '' };
	} catch (e) {
		const err = e as { status: number; stdout: string; stderr: string };
		return { status: err.status, stdout: err.stdout, stderr: err.stderr };
	}
}

describe('format-cli (compiled CLI, run as a subprocess)', () => {
	beforeAll(() => {
		// Fails loudly if `npm run compile` hasn't been run — the whole test is meaningless
		// against a stale/missing build.
		readFileSync(CLI, 'utf8');
	});

	it('rewrites an unformatted file in place and exits 0', () => {
		const file = tempFile(UNFORMATTED);
		const { status, stdout } = run([file]);
		expect(status).toBe(0);
		expect(stdout).toContain('formatted:');
		expect(readFileSync(file, 'utf8')).toBe(CANONICAL);
		rmSync(file, { force: true });
	});

	it('reports unchanged (and does not rewrite) an already-canonical file', () => {
		const file = tempFile(CANONICAL);
		const { status, stdout } = run([file]);
		expect(status).toBe(0);
		expect(stdout).toContain('unchanged:');
		rmSync(file, { force: true });
	});

	it('--check does not write, and exits 1 when a file needs formatting', () => {
		const file = tempFile(UNFORMATTED);
		const { status, stdout } = run([file, '--check']);
		expect(status).toBe(1);
		expect(stdout).toContain('would format:');
		expect(readFileSync(file, 'utf8')).toBe(UNFORMATTED); // untouched
		rmSync(file, { force: true });
	});

	it('--check exits 0 when every file is already canonical', () => {
		const file = tempFile(CANONICAL);
		const { status, stdout } = run([file, '--check']);
		expect(status).toBe(0);
		expect(stdout).toContain('unchanged:');
		rmSync(file, { force: true });
	});

	it('--check across multiple files: any one unformatted file fails the whole run', () => {
		const clean = tempFile(CANONICAL);
		const dirty = tempFile(UNFORMATTED);
		const { status } = run([clean, dirty, '--check']);
		expect(status).toBe(1);
		expect(readFileSync(dirty, 'utf8')).toBe(UNFORMATTED); // still untouched
		rmSync(clean, { force: true });
		rmSync(dirty, { force: true });
	});

	it('exits 1 and reports an error for a missing file, without touching the exit code contract of --check', () => {
		const { status, stdout } = run(['/definitely/does/not/exist.md']);
		expect(status).toBe(1);
		expect(stdout).not.toContain('formatted:');
	});

	it('with no file args, prints usage and exits 1', () => {
		const { status } = run([]);
		expect(status).toBe(1);
	});

	it('--check honours an explicit --width N — a general "formatted at this width" gate, not commit-only', () => {
		const wide = '| Key | Description |\n| :-- | --- |\n| alpha | a fairly long description that certainly needs to wrap onto several continuation rows |\n';
		const file = tempFile(wide);
		execFileSync('node', [CLI, file, '--width', '44']); // rewrite it to the width-44 wrapped form
		// The width-44 form is exactly what --check --width 44 expects: passes.
		const atSameWidth = run([file, '--check', '--width', '44']);
		expect(atSameWidth.status).toBe(0);
		expect(atSameWidth.stdout).toContain('unchanged:');
		// The same file checked against width 0 (the commit form) is NOT canonical — the wrapped
		// continuation rows aren't the width-0 shape — proving --width genuinely changes what
		// --check validates against, not just whether it validates.
		const atCommitWidth = run([file, '--check']);
		expect(atCommitWidth.status).toBe(1);
		expect(atCommitWidth.stdout).toContain('would format:');
		rmSync(file, { force: true });
	});
});
