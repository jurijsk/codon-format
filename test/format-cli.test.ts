/**
 * format-cli.test.ts — exercises the COMPILED CLI (out/format-cli.js) as a subprocess, the same
 * way an external consumer (pre-commit hook, CI step, another project's tasks.json) would call it.
 * Deliberately black-box: no importing the module's internals, since its whole point is to be a
 * standalone, vscode-free executable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'codon-cli-discover-test-'));
}

function run(args: string[], options: { cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
	// spawnSync (not execFileSync): needs both streams regardless of exit code — execFileSync
	// discards stderr on a zero exit, which silently hides notices the CLI prints on success.
	//
	// cwd ALWAYS defaults to a fresh, empty temp dir — never this repo's own working directory.
	// Bare `codon-format` (no file args, no discovery flag) now discovers and REWRITES every
	// markdown file under cwd by default; a test that omitted an explicit cwd here once actually
	// reformatted this repo's own samples/*.md as a side effect of running the test suite.
	const result = spawnSync('node', [CLI, ...args], { encoding: 'utf8', cwd: options.cwd ?? tempDir() });
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
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

	it('with no file args and no discovery flag, defaults to --git-driven from cwd', () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, 'a.md'), UNFORMATTED);
		const { status, stdout, stderr } = run([], { cwd });
		expect(status).toBe(0);
		expect(stderr).toContain('defaulting to --git-driven');
		expect(stdout).toContain('formatted:');
		expect(readFileSync(join(cwd, 'a.md'), 'utf8')).toBe(CANONICAL);
		rmSync(cwd, { recursive: true, force: true });
	});

	it('by default, same-header tables do NOT share column widths', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n' + '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const file = tempFile(doc);
		run([file]);
		const out = readFileSync(file, 'utf8');
		const tables = out.split('\n\n');
		expect(tables[0].split('\n')[0]).not.toBe(tables[1].split('\n')[0]);
		rmSync(file, { force: true });
	});

	it('--align-tables-width makes same-header tables share column widths', () => {
		const doc = '| Name | Note |\n| --- | --- |\n| A | x |\n\n' + '| Name | Note |\n| --- | --- |\n| Alexandria | a longer note here |\n';
		const file = tempFile(doc);
		run([file, '--align-tables-width']);
		const out = readFileSync(file, 'utf8');
		const tables = out.split('\n\n');
		expect(tables[0].split('\n')[0]).toBe(tables[1].split('\n')[0]);
		rmSync(file, { force: true });
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

	describe('--git-driven / --all (project-wide discovery)', () => {
		it('--all formats every matching file under --root, skipping node_modules by default', () => {
			const root = tempDir();
			mkdirSync(join(root, 'docs'), { recursive: true });
			mkdirSync(join(root, 'node_modules'), { recursive: true });
			writeFileSync(join(root, 'docs', 'a.md'), UNFORMATTED);
			writeFileSync(join(root, 'node_modules', 'b.md'), UNFORMATTED);

			const { status, stdout } = run(['--all', '--root', root]);
			expect(status).toBe(0);
			expect(stdout).toContain(join(root, 'docs', 'a.md'));
			expect(stdout).not.toContain(join(root, 'node_modules', 'b.md'));
			expect(readFileSync(join(root, 'docs', 'a.md'), 'utf8')).toBe(CANONICAL);
			rmSync(root, { recursive: true, force: true });
		});

		it('--git-driven falls back to --all with a stderr notice when --root is not a git working tree', () => {
			const root = tempDir();
			writeFileSync(join(root, 'a.md'), UNFORMATTED);

			const { status, stdout, stderr } = run(['--git-driven', '--root', root]);
			expect(status).toBe(0);
			expect(stderr).toContain('not a git working tree');
			expect(stdout).toContain(join(root, 'a.md'));
			rmSync(root, { recursive: true, force: true });
		});

		it('--git-driven respects .gitignore inside a real git working tree', () => {
			const root = tempDir();
			execFileSync('git', ['init', '--quiet'], { cwd: root });
			writeFileSync(join(root, '.gitignore'), 'ignored.md\n');
			writeFileSync(join(root, 'a.md'), UNFORMATTED);
			writeFileSync(join(root, 'ignored.md'), UNFORMATTED);

			const { stdout } = run(['--git-driven', '--root', root]);
			expect(stdout).toContain(join(root, 'a.md'));
			expect(stdout).not.toContain(join(root, 'ignored.md'));
			rmSync(root, { recursive: true, force: true });
		});

		it('--ignore adds an exclusion on top of the defaults, without replacing them', () => {
			const root = tempDir();
			mkdirSync(join(root, 'output'), { recursive: true });
			mkdirSync(join(root, 'node_modules'), { recursive: true });
			writeFileSync(join(root, 'output', 'a.md'), UNFORMATTED);
			writeFileSync(join(root, 'node_modules', 'b.md'), UNFORMATTED);

			const { stdout } = run(['--all', '--root', root, '--ignore', 'output']);
			expect(stdout).not.toContain(join(root, 'output', 'a.md'));
			expect(stdout).not.toContain(join(root, 'node_modules', 'b.md'));
			rmSync(root, { recursive: true, force: true });
		});

		it('--git-driven and --all are mutually exclusive', () => {
			const { status, stderr } = run(['--git-driven', '--all']);
			expect(status).toBe(1);
			expect(stderr).toContain('mutually exclusive');
		});

		it('a discovery flag combined with an explicit file path is an error', () => {
			const file = tempFile(UNFORMATTED);
			const { status, stderr } = run(['--all', file]);
			expect(status).toBe(1);
			expect(stderr).toContain('mutually exclusive');
			rmSync(file, { force: true });
		});

		it('exits 0 (not the usage error) when discovery finds zero matching files', () => {
			const root = tempDir();
			const { status, stdout } = run(['--all', '--root', root]);
			expect(status).toBe(0);
			expect(stdout).toContain('no markdown files found');
			rmSync(root, { recursive: true, force: true });
		});
	});
});
