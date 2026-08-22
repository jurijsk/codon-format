/**
 * discover.test.ts — pins src/discover.ts: the simple path matcher, the plain filesystem walk,
 * and the git-backed listing (including its null-on-any-failure contract, which callers rely on
 * to fall back rather than throw). See docs/project-wide-discovery-spec.md for the design.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverMarkdownFiles, discoverGitDriven, discoverAll, matchesIgnore, DEFAULT_IGNORE } from '../src/discover.js';

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'codon-discover-test-'));
}

function initRepo(root: string): void {
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
}

describe('matchesIgnore', () => {
	it('matches an unanchored directory-name pattern at any depth, not a substring of a longer name', () => {
		expect(matchesIgnore('node_modules/x.md', ['node_modules'])).toBe(true);
		expect(matchesIgnore('a/b/node_modules/x.md', ['node_modules'])).toBe(true);
		expect(matchesIgnore('a/node_modules_extra/x.md', ['node_modules'])).toBe(false);
	});

	it('matches a multi-segment prefix pattern at a segment boundary, not a substring', () => {
		expect(matchesIgnore('.meta/debug/x.md', ['.meta/debug'])).toBe(true);
		expect(matchesIgnore('.meta/debugger/x.md', ['.meta/debug'])).toBe(false);
		expect(matchesIgnore('.meta/debug', ['.meta/debug'])).toBe(true);
	});

	it('strips a single trailing slash from a pattern (the common gitignore dir-only convention)', () => {
		expect(matchesIgnore('output/x.md', ['output/'])).toBe(true);
	});

	it('does not match unrelated paths', () => {
		expect(matchesIgnore('docs/a.md', ['tmp', 'output'])).toBe(false);
	});
});

describe('discoverAll (plain walk, never touches git)', () => {
	it('walks the tree and applies DEFAULT_IGNORE plus extra --ignore patterns, merged not replaced', () => {
		const root = tempDir();
		mkdirSync(join(root, 'docs'), { recursive: true });
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		mkdirSync(join(root, 'build'), { recursive: true });
		writeFileSync(join(root, 'docs/a.md'), 'x');
		writeFileSync(join(root, 'node_modules/b.md'), 'x');
		writeFileSync(join(root, 'build/c.md'), 'x');
		writeFileSync(join(root, 'build/d.mdc'), 'x');
		writeFileSync(join(root, 'e.txt'), 'x');

		const files = discoverMarkdownFiles({ root, mode: 'all', ignore: ['build'] }).sort();
		expect(files).toEqual(['docs/a.md']);
		rmSync(root, { recursive: true, force: true });
	});

	it('excludes .git even when root is a real, committed repo, with no explicit --ignore needed', () => {
		const root = tempDir();
		mkdirSync(join(root, 'docs'), { recursive: true });
		writeFileSync(join(root, 'docs/a.md'), 'x');
		initRepo(root);
		execFileSync('git', ['add', '.'], { cwd: root });
		execFileSync('git', ['commit', '--quiet', '-m', 'x'], { cwd: root });

		const files = discoverMarkdownFiles({ root, mode: 'all' });
		expect(files).toEqual(['docs/a.md']);
		rmSync(root, { recursive: true, force: true });
	});

	it('root-relative, forward-slash-normalized paths, matching all three extensions', () => {
		const root = tempDir();
		mkdirSync(join(root, 'a', 'b'), { recursive: true });
		writeFileSync(join(root, 'a', 'b', 'c.qmd'), 'x');
		expect(discoverAll(root, DEFAULT_IGNORE)).toEqual(['a/b/c.qmd']);
		rmSync(root, { recursive: true, force: true });
	});
});

describe('discoverGitDriven', () => {
	it('returns null (never throws) outside a git working tree', () => {
		const root = tempDir();
		expect(discoverGitDriven(root, DEFAULT_IGNORE)).toBeNull();
		rmSync(root, { recursive: true, force: true });
	});

	it('lists tracked + untracked-but-not-ignored files, respecting .gitignore and DEFAULT_IGNORE', () => {
		const root = tempDir();
		initRepo(root);
		writeFileSync(join(root, '.gitignore'), 'ignored.md\n');
		writeFileSync(join(root, 'a.md'), 'x');
		writeFileSync(join(root, 'ignored.md'), 'x');
		mkdirSync(join(root, 'node_modules'));
		writeFileSync(join(root, 'node_modules', 'b.md'), 'x');

		const files = discoverGitDriven(root, DEFAULT_IGNORE);
		expect(files?.sort()).toEqual(['a.md']);
		rmSync(root, { recursive: true, force: true });
	});

	it('a TRACKED file matching an --ignore pattern is still excluded (the --exclude= bug this avoids via pathspec magic)', () => {
		const root = tempDir();
		initRepo(root);
		mkdirSync(join(root, 'test_data'));
		writeFileSync(join(root, 'test_data', 'a.md'), 'x');
		writeFileSync(join(root, 'b.md'), 'x');
		execFileSync('git', ['add', '.'], { cwd: root });
		execFileSync('git', ['commit', '--quiet', '-m', 'x'], { cwd: root });

		const files = discoverGitDriven(root, [...DEFAULT_IGNORE, 'test_data']);
		expect(files?.sort()).toEqual(['b.md']);
		rmSync(root, { recursive: true, force: true });
	});

	it('root-relative paths even when root is a subdirectory of a larger repo (no --full-name)', () => {
		const root = tempDir();
		initRepo(root);
		mkdirSync(join(root, 'sub', 'docs'), { recursive: true });
		writeFileSync(join(root, 'sub', 'docs', 'a.md'), 'x');

		const files = discoverGitDriven(join(root, 'sub'), DEFAULT_IGNORE);
		expect(files).toEqual(['docs/a.md']);
		rmSync(root, { recursive: true, force: true });
	});
});

describe('discoverMarkdownFiles (mode: git-driven, the default)', () => {
	it('falls back to the plain walk when root is not a git working tree', () => {
		const root = tempDir();
		mkdirSync(join(root, 'docs'), { recursive: true });
		writeFileSync(join(root, 'docs', 'a.md'), 'x');
		expect(discoverMarkdownFiles({ root })).toEqual(['docs/a.md']);
		rmSync(root, { recursive: true, force: true });
	});

	it('uses the git-backed listing when root is a working tree', () => {
		const root = tempDir();
		initRepo(root);
		writeFileSync(join(root, 'a.md'), 'x');
		expect(discoverMarkdownFiles({ root })).toEqual(['a.md']);
		rmSync(root, { recursive: true, force: true });
	});
});
