---
title: Markdown authoring rules for this repo
description: This repo formats its own Markdown with codon-format, the tool built here — the rule, why, and how to run it.
applyTo: '**/*.md'
---

# Markdown authoring

This repo's target flavor is plain **GFM/CommonMark** — no MDC, no Comark. (MDC block-component syntax is something this formatter *detects and preserves* for consumers like `jurijsk.codon` and `daina6`, but this repo doesn't author any itself.)

## The rule: format with `codon-format`, not by hand

After editing any `.md` file in this repo — including this one — run the formatter on it before considering the edit done:

```
node out/format-cli.js <file>
```

(or `npx codon-format <file>` once published; both default to width 0, the only commit-safe form — see [docs/design.md](../../docs/design.md) for why). Don't hand-wrap paragraphs to a line width or hand-pad table columns — canonical output is *whatever the tool produces*, and a hand-formatted file that looks right can still diverge from it in ways that only show up as a diff later. This is also the actual dogfooding test: if a doc in this repo can't be run through `codon-format` cleanly, that's a real bug to fix, not a reason to route around the tool.

Run `npm run compile` first if `out/` doesn't exist yet or is stale.
