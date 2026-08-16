# Project Instructions

@.github/copilot-instructions.md

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for project instructions.


<!--
Notes on syntax with parsing meaning to Claude Code (other agents can ignore).
Source: https://code.claude.com/docs/en/memory

- Block-level HTML comments like this one are stripped before CLAUDE.md is
  injected into Claude's context at session start, so they cost no tokens.
  They DO remain visible when Claude opens this file with the Read tool.
- `@path/to/file` — Claude Code expands the referenced file's contents into
  context at launch. Relative paths resolve relative to the importing file
  (not the working directory). Recursive up to 5 hops. Used above so the
  copilot instructions are loaded as instructions, not just linked.
- YAML front-matter with a `paths:` field — only meaningful inside
  `.claude/rules/*.md` files (scopes a rule to matching globs). Not used here.
- `CLAUDE.local.md` — if present alongside this file, appends after it. Not
  checked into git by convention; use for personal/local overrides.
-->
