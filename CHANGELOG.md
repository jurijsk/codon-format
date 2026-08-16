# Changelog

## 0.2.2

- Fixed a bug where a commented-out fenced code cell (`<!-- ```{r} … ``` -->`, a dormant Quarto cell) before an MDC block desynced `mdc.ts`'s fence tracking, silently hiding every MDC block for the rest of the file. MDC detection now skips multi-line HTML comments whole, same as the reflow and list-tighten passes already did.

## 0.2.1

- Renamed `src/listTighten.ts` → `src/list-tighten.ts` (internal only, no functional change — same kebab-case cleanup as 0.2.0's other renames).

## 0.2.0

- Width-0 table padding no longer caps at 80 characters — columns always pad to the widest cell, so pipes stay aligned even with very long cells.
- Renamed `src/formatMdCli.ts` → `src/format-cli.ts` and `src/markdownTextFormat.ts` → `src/markdown-format.ts` (internal; the public import and `codon-format` bin are unaffected).
- Docs: clarified that pre-commit/CI usage relies on the `--width 0` default.

## 0.1.1

- Fixed a raw NUL byte accidentally embedded in table header key generation, which made affected files register as binary to git/grep/etc.

## 0.1.0

- Initial extraction of Codon's markdown formatter as a standalone package.
- Fixed the published bin path (a leading `./` was silently dropped by npm registry validation).
