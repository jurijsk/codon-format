# MD Anderson chart-print export — measured statistics

Reference measurements from the 919-page Epic chart print this project is tuned against. Kept because every design decision about the text artifacts — page chrome, encounter runs, joint spacing, what a "duplicate" is — was made against these numbers, and re-deriving them costs an afternoon.

**Patient-specific values are replaced with shape-preserving placeholders**, as in the bug reports: section headings that were a diagnosis or a clinician's name appear here as `<diagnosis>` / `<clinician>, RN`, and medication names as `<BRAND> <dose>`. The statistics are unmodified.

## The document

|                  |                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source           | Epic chart print, MD Anderson Cancer Center, **one patient**, delivered as a Datavant/SmartRequest courier bundle |
| Pages            | 919                                                                                                               |
| PDF              | 23.9 MB                                                                                                           |
| Extracted text   | 3.66 MB (OCR'd; the `_converted` variant)                                                                         |
| Structure        | ~80 per-encounter documents concatenated, each reprinting the standing sections                                   |
| Bookmarks        | **none** — which is why the outline-driven `dedupe` strategies cannot see it                                      |

Measured on the redacted text export unless stated. To reproduce: extract with `dump text`, then walk the fenced page bodies.

## Page furniture

Six lines per page, on **915 of 919** pages (99.6%):

| Position | Line                                                                   | Detected as chrome?                        |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| top 1–3  | the logo, OCR'd (`MDAnderson` / `Ganeer Center …` / `Hiaking Once Tl`) | yes                                        |
| top 4    | `MRN: <mrn>, DOB: <dob>, Legal Sex: F`                                 | yes                                        |
| top 5    | `Visit date: <date>` (679) / `Adm: <date>, D/C: <date>` (232)          | **no** — structural, the run rule reads it |
| bottom 1 | `Generated on <date> <time>`                                           | yes (only after date/time normalization)   |

The four pages without it: a courier cover sheet, and three pages of a **scanned** authorization form where the same logo, photographed rather than drawn, OCR'd as `TRE UNIVERSITY OF TEXAS` / `Making Cancer History?`.

Two facts worth keeping:

- **The logo is OCR'd once, not per page.** `extractLayoutText` deduplicates images by content hash and stamps one OCR result over every drawing of the image — which is why the line is byte-identical on 915 pages, and why frequency detection works so well here.
- **`Generated on …` scores 66.6% / 33.0% as two literals** (`1:21 PM` on 612 pages, `1:22 PM` on 303 — the print job straddled a minute boundary) and 99.6% once dates and times are normalized. Hand-enumerating literals would have silently missed a third minute.

## Encounter runs

|                  |                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Pages → runs     | 919 → **186**                                                                                                     |
| Longest run      | 60 pages — **694 to 753**                                                                                         |
| Next longest     | 45 (620–664), 43 (835–877)                                                                                        |
| Single-page runs | 44                                                                                                                |

The 186 runs are contiguous and cover all 919 pages with no gaps or overlaps. **The 60-page run was checked against the un-compacted pages**, because a run that long is also what a wrong merge would look like: all 60 pages carry one date-line key, one banner key, and one _unmasked_ banner date, and 59 of the 60 say `(continued)` — the unmarked one being page 694, the run's own first page, which is the correct signature. Its boundaries hold from the other side too: page 693 is also an `Adm:` page but its banner title differs, and page 754 switches to `Visit date:`. It is a single same-day admission for an interventional-radiology biopsy under anesthesia, and 60 pages of pre-anesthesia H&P, labs, imaging and medication administration is a plausible print for one.

**186 is the current rule.** The other measurements in this document were taken on the earlier 188-run grouping, before the title grammar landed; the two differ only in pages 5–7, so none of the figures below move materially. The delivered artifacts are regrouped by the next `[2] redact`.

Over 918 consecutive page pairs:

| Outcome                                                                | Pairs |
| ---------------------------------------------------------------------- | ----- |
| merge — encounter grammar: header matches, banner says `(continued)`   | 731   |
| merge — title grammar: title repeats and says `(continued)`            | 2     |
| header matches, no marker (a _second_ document for the same encounter) | 54    |
| marker present, header differs                                         | **0** |
| unrelated, a new encounter begins                                      | 126   |
| neither page has a date line, and no title match                       | 5     |

**Pages 1–7 have no encounter date line**, and they are two different things — which is what made a second grammar necessary and also what bounds it.

Pages 5–7 are a patient-summary document that **does** mark its continuations, in a shape the encounter grammar cannot read: the marker sits on the **title** line (`Patient (continued)`) while the line below is a section name that legitimately changes (`Demographics` → `Current Medications (continued)` → `Vitals (continued)`). The title grammar reads it, merging those 2 pairs into one 3-page run headed `Patient`. That is its entire yield on this document — 186 runs instead of 188 — so it is a completeness fix, not a compression one.

The other four are why `(continued)` stays mandatory in **both** grammars. Page 1 is the Datavant courier cover sheet; pages 2–4 are the scanned authorization form whose photographed logo OCR'd to `TRE UNIVERSITY OF TEXAS` — three separate pages that open with an **identical** first line and carry no marker anywhere. A rule that merged on the repeated line alone would fuse three unrelated documents into one, and it would look exactly like a successful merge.

Zero conflicts, so requiring both signals costs nothing. An independent prototype that segmented by parsing banners found 158 blocks — close enough to 186 to corroborate the segmentation.

## Section volume

Extents are drawn with the shipped **named** heading vocabulary (the 36 section names the `md-epic-chart-print` strategy carries — [implementation/text-export.md](implementation/text-export.md)). Both columns use that one set: `before` is the run-grouped export (chrome + runs only), `now` is the same file after every readability strip (including the new `drop`/`empty` passes) and the collapse pass.

Body total: **3,125,722 → 1,935,728 chars** (−1,189,994, 38.1%). The two `% of body` columns are each taken against their own total, so the second says what the file looks like **now**. Ordered by what is now biggest.

| Section                                 | Printings | Before  | % of body | Now     | % of body | Removed   |
| --------------------------------------- | --------: | ------: | --------: | ------: | --------: | --------: |
| Labs                                    | 18        | 598,525 | 19.1%     | 462,707 | **23.9%** | 22.7%     |
| CA 125                                  | 7         | 342,428 | 11.0%     | 341,072 | **17.6%** | 0.4%      |
| Medication List                         | 140       | 930,699 | **29.8%** | 187,706 | 9.7%      | **79.8%** |
| Pathology Reports                       | 4         | 186,103 | 6.0%      | 175,470 | 9.1%      | 5.7%      |
| Tumor markers:                          | 15        | 198,746 | 6.4%      | 148,943 | 7.7%      | 25.1%     |
| Imaging                                 | 18        | 123,126 | 3.9%      | 102,781 | 5.3%      | 16.5%     |
| _(before any heading)_                  | —         | 94,844  | 3.0%      | 94,696  | 4.9%      | 0.2%      |
| Clinical Notes                          | 73        | 116,668 | 3.7%      | 94,410  | 4.9%      | 19.1%     |
| Current Medications                     | 11        | 80,593  | 2.6%      | 60,913  | 3.1%      | 24.4%     |
| Provider Notes                          | 22        | 59,772  | 1.9%      | 50,165  | 2.6%      | 16.1%     |
| Visit Information                       | 177       | 132,341 | 4.2%      | 46,985  | 2.4%      | **64.5%** |
| Reason for Visit                        | 151       | 38,073  | 1.2%      | 28,758  | 1.5%      | 24.5%     |
| Lab Results                             | 9         | 49,415  | 1.6%      | 27,257  | 1.4%      | 44.8%     |
| Past Surgical History:                  | 9         | 62,321  | 2.0%      | 26,813  | 1.4%      | 57.0%     |
| Allergies                               | 12        | 29,016  | 0.9%      | 18,614  | 1.0%      | 35.8%     |
| Problem List Items Addressed This Visit | 6         | 14,313  | 0.5%      | 13,450  | 0.7%      | 6.0%      |
| _21 smaller sections_                   | —         | 68,739  | 2.2%      | 54,988  | 2.8%      | 20.0%     |

**Labs is still the biggest section, and `CA 125` is now second — but the second is a measurement artifact, not a real section.** Labs is **462,707 of the 1,935,728 remaining (23.9%)**: 18 printings of a huge section (each genuinely different, so only 22.7% collapses). `CA 125` reads as 341,072 (17.6%) only because the heading is a leaf that catches **20 lab-_order_ lines** (in the treatment-plan episodes and lab-collection encounters), and the order detail below each — which has no recognized heading — is swallowed into it. It is the same vocabulary-coverage inflation the `Tumor markers:` note below describes, and it is the same order-detail boilerplate the order-glossary strip would deflate ([implementation/text-export.md](implementation/text-export.md)).

**Medication List** is the opposite profile — 140 printings of a small section, **79.8% a reprint**, dropping to 187,706 (9.7%).

**The `drop`/`empty` passes are visible here.** `Visit Information` fell **64.5%** (177 printings → 46,985), because its `Provider Information`, `Department`, `Level of Service` and empty `Nursing Assessment` blocks are dropped and the bodiless heading tidied away; `Labs`, `Imaging`, `Pathology Reports` and `Lab Results` each shed their `Testing Performed By` directory (22.7% / 16.5% / 5.7% / 44.8% removed). `Pathology Reports` is new to the table — a col-0 section added to the vocabulary in this refresh.

The text **before any heading** is the other survivor at 94,696 (4.9% of what remains) — the encounter header plus whatever the print emitted before naming a section, with no name to compare by.

**`Tumor markers:` is inflated here (198,746 before) for the reason discussed below** — without the diagnosis line as a boundary the section swallows the growing CA125 table and a static narrative, so it reads large and collapses only 25.1%. Block-level collapse would recover the trapped static part ([plans/block-level-collapse.md](plans/block-level-collapse.md)).

### Caveat: column 0 is not a heading signal

Only 42 of 2,381 column-0 lines are headings. The rest are narrative lines, multi-column table rows (`<date>   <value>`), and — the awkward category — **wrapped fragments of long medication names** (`(<BRAND>) <dose>`, `MISC)`, `<INGREDIENT>, BULK,`, `ORAL`), which `pdftotext -layout` wraps to a new line at column 0.

Some of those fragments recur often enough to pass a recurrence filter, so the small rows in the table above are unreliable; the large ones are sound. Any section-extent work needs a stronger rule than position, and the frequency-plus-shape filter used here (recurs in ≥5 runs, ≤45 chars, starts upper-case, no digit start, no 3-space run) is a first approximation, not a solution.

## Medication List, in detail

140 printings, **934,602 chars**, one in each of 140 runs. Measured with the learned heading set for extents and blank-line blocks for entries, which reproduces the 934,602 total exactly.

| Level         | Printings | Distinct      | Redundancy if collapsed to one copy each |
| ------------- | --------: | ------------- | ---------------------------------------: |
| whole section | 140       | **37 texts**  | **81.4%**                                |
| entry state   | 2,124     | **86 states** | **97.2%**                                |
| drug identity | 2,124     | **41 drugs**  | —                                        |

Entries are **93.1%** of the section volume (869,698 of 934,602); the remaining 6.9% is per-printing furniture.

**Whole-section collapse is far more effective than previously recorded.** 103 of the 140 printings are a repeat of a section already printed earlier, so collapsing identical sections recovers **81.4%** — 760,514 chars, 24.3% of the document — with no restructuring at all, since the claim is only "this text appeared before". Entry-level collapse beats it (97.2%) but requires parsing.

**The right unit is the entry _state_, not the drug.** There are only 41 distinct drugs but 86 distinct entry states, because 21 drugs appear in more than one state as their lifecycle advances — a start date is filled in, a discontinuation reason is added, instructions are rewritten — and **one drug appears in 11 states**. Keying on the drug name would silently merge a medication's before and after. Keying on the whole block does not.

**Dates do not drift within an entry.** Masking dates before comparing yields the same 86 distinct states as exact comparison, so a printing of an entry is byte-identical to its previous printing. Exact matching is sufficient here; no fuzzy or date-tolerant comparison is needed.

**Whole-section collapse is what shipped**, as the `collapse` pass of `compact text`, using the strategy's **named** heading vocabulary. On this document it now removes **156 sections for 809,298 chars** — fewer than the 215 / 849,433 it folded before the `drop`/`empty` passes existed, because `drop` deletes repeated admin blocks outright rather than leaving them for collapse to fold. Verified with every collapsed body still present in the output and no pointer pointing at an older copy.

> **Cost of the named vocabulary, measured.** The shipped set deliberately excludes two lines the earlier _learned_ set treated as boundaries — the patient's diagnosis and a clinician's name — because neither can live in shared source. Those lines were doing structural work: the diagnosis sat between the `Tumor markers:` CA125 table (which grows every visit) and a static history narrative, cutting the static part into its own collapsible section. Without it, `Tumor markers:` collapses **5×** instead of 16×, and the static narrative shows **12 times** instead of once. This is the flip side of keeping PII out of the vocabulary, and the fix is block-level collapse ([plans/block-level-collapse.md](plans/block-level-collapse.md)), which folds the narrative regardless of section boundaries.

An entry-level table-plus-reference representation would go further — 86 entry states once, 47 active-set lists, a per-printing reference, one disclaimer, **≈30,700 chars against 934,602, saving ~904,000, or 28.9% of the document** — but it needs an entry parser for Epic's layout and would leave the export non-self-contained, so it is measured here and not built.

The active sets are themselves the clinically useful artifact: **47 distinct sets across 140 printings**, 27 of them occurring exactly once, with 1,036 add/remove events over 92 changes (median 7 per change) and set sizes from 0 to 29. That is the timeline of when the medication list actually changed, which reading 140 near-identical printings does not give you.

Two smaller, unambiguous wins inside the section: the two-line "for documentation purposes only" disclaimer costs **30,798 chars** reprinted 118 times, and **22 printings contain no entries at all** — a heading and a disclaimer and nothing else, 6,420 chars.

The most-printed single entry state appears **115 times**; the median state appears 3 times.

## Reduction, pass by pass

What each pass of `compact text` takes off the delivered text, measured on the file itself rather than on normalized bodies. The Epic strategy runs them in this order:

| Stage                                     | Bytes     | Removed        | Of previous |
| ----------------------------------------- | --------: | -------------: | ----------: |
| as `[2] redact` wrote it                  | 3,666,130 | —              | —           |
| + chrome & encounter runs                 | 3,127,215 | −538,915       | 14.7%       |
| + time-of-day stamps                      | 3,107,703 | −19,512        | 0.6%        |
| + author tags (`[OI.1T]`)                 | 3,106,345 | −1,358         | 0.0%        |
| + admin lines (sign-off / reconciliation) | 2,918,387 | −187,958       | 6.1%        |
| + drop (self-labeling admin blocks)       | 2,788,988 | −129,399       | 4.4%        |
| + empty (headings a drop left bodiless)   | 2,785,031 | −3,957         | 0.1%        |
| + blank-line tidy                         | 2,754,804 | −30,227        | 1.1%        |
| + collapse                                | 1,974,896 | −779,908       | 28.3%       |
| **cumulative**                            | 1,974,896 | **−1,691,234** | **46.1%**   |

Three different promises, which should not be added up as though they were one:

- **Furniture hoisted (14.7%).** Chrome and run-grouping move the repeated header and footer into the run heading. This row also absorbs the render-time **flush-left dedent** of the compacted deliverable (it is the first run-grouped render), so a little whitespace genuinely leaves here; the strip rows below it are dedent-neutral, so their deltas are clean.
- **Record content deleted (times, tags, admin, drop, empty, collapse).** Clock times, Epic author tags, the administrative sign-off / reconciliation lines (`admin`), and whole self-labeling admin BLOCKS (`drop` — the performing-lab directory, the clinic `Department`, `Provider Information`, the `Level of Service` billing block, and the empty `Nursing Assessment` placeholder) are cut for readability, and `empty` removes a section heading a drop left with no body. Collapse then replaces **156 sections** whose text is byte-identical to a copy still present (809,298 chars). Each of these is what the document _says_, not what the printer added.
- **Whitespace tidied (blank-line tidy).** Cosmetic — it collapses the blank lines the strips above leave (more now, since `drop`/`empty` open more of them).

All of it is reversible by re-running `[2] redact`, which rebuilds the export from the verified PDF. The strips run BEFORE collapse on purpose: removing what varies between otherwise-identical printings lets more of them fold — and `drop`/`empty` run among them because a facility directory or a bare heading is exactly that kind of noise.

## Duplication overall

| Stage                          | Total chars | Recoverable duplication |
| ------------------------------ | ----------: | ----------------------: |
| as shipped, per page           | 2,018,277   | 962,928 — 47.7%         |
| chrome stripped                | 1,896,407   | 904,239 — 47.7%         |
| chrome stripped + pages merged | 1,805,975   | 875,104 — 48.5%         |
| …with page-break gaps closed   | —           | **50.3%**               |

Closing the joints took block count from 9,288 to 7,354 (≈1,934 fragments rejoined) and distinct blocks from 3,750 to 3,111. Of 717 joints, **404 (56.3%)** produce a block the document prints elsewhere — see [bugs/page-joint-spacing-is-a-guess.md](bugs/page-joint-spacing-is-a-guess.md).

**Exact matching is sufficient.** Masking dates before comparing blocks recovers only 3.9 points more, which does not justify fuzzy matching.

## Date mentions

This is the date **landscape** of the record — measured on the export as it stood before the author-tag and admin strips existed and before the current heavier collapse, because that landscape is the picture that motivated those passes. The per-page furniture dates are already gone (the `Generated on <date> <time>` footer hoisted out, each continuation page's `Visit date:` folded into its run heading; headings sit outside the fences and are not counted).

| Body lines | Date mentions | Distinct dates |
| ---------: | ------------: | -------------: |
| 47,511     | **10,830**    | **396**        |

**396 distinct dates printed 10,830 times** — a 27× amplification, the same shape as the medication finding and for the same reason: each encounter reprints the standing sections, and every entry in them carries its own lifecycle dates.

**What ships now carries far fewer.** The **admin strip** removes the attribution bucket below (§ _Dates inside a field's value_) — **1,058 dates** — and the heavier medication-list collapse folds the lifecycle-date-dense sections; the delivered file held **4,946** `M/D/Y` dates against 10,792 at the time that was measured. That figure now predates the `drop`/`empty` passes (which delete more dated lines, e.g. the `Valid Date Range` rows of every `Testing Performed By` block) and the per-page fence-note dates the position rework added, so the current shipped count differs — a full re-measure of the date landscape is its own pass and has not been redone here. The breakdown below is kept as the design baseline: what a chart print looks like _before_ compaction, and what the label taxonomy the admin strip keys on was built from.

### One format, two inconsistencies

| Format                 | Count  | Share |
| ---------------------- | -----: | ----: |
| `M/D/YYYY` or `M/D/YY` | 10,792 | 99.6% |
| `Month D, YYYY`        | 20     | 0.2%  |
| `Month YYYY` (no day)  | 13     | 0.1%  |
| `DD-Mon-YY`            | 5      | 0.0%  |

Effectively a single format, but it is not uniform within itself: **1,656 (15.3%) carry a two-digit year** and **1,761 (16.3%) a zero-padded month**, so neither field width can be assumed.

**The ordering is provably M/D, not D/M** — 4,693 dates have a second field above 12, and the only 4 with a first field above 12 are journal-citation URL paths (`/content/28/20/3323.full.pdf`). That is worth keeping for a different reason: **URL path segments are a false-positive class** for any `\d{1,2}/\d{1,2}/\d{2,4}` detector, and this record contains them.

### Half of all dates carry an explicit label

**5,528 (51.0%) are introduced by a label**, across 52 distinct ones — 17 of which appear exactly once.

| Label              | Mentions | Share |
| ------------------ | -------: | ----: |
| `Entered on:`      | 1,661    | 15.3% |
| `Start date:`      | 1,065    | 9.8%  |
| `Discontinued on:` | 740      | 6.8%  |
| `End date:`        | 714      | 6.6%  |
| `Ordered on:`      | 404      | 3.7%  |
| `Visit date:`      | 158      | 1.5%  |
| `Filed:`           | 124      | 1.1%  |
| `Resulted:`        | 116      | 1.1%  |
| `Encounter Date:`  | 99       | 0.9%  |
| `Expected:`        | 69       | 0.6%  |
| `Expires:`         | 59       | 0.5%  |
| `Last dispensed:`  | 43       | 0.4%  |
| `Collection Time:` | 32       | 0.3%  |
| `Date of Service:` | 25       | 0.2%  |
| `Adm:` / `D/C:`    | 22 each  | 0.4%  |
| 37 others          | ≤22 each | 2.0%  |

**The top five are all medication-lifecycle fields and account for 42.3% of every date in the document** — which is the Medication List's 29.9% of volume showing up in a second, independent measurement.

Two label facts that matter to anyone keying on them: `Collection Time:` holds a **date**, not a time, so the name cannot be trusted to indicate the value's type; and the same concept arrives under several spellings (`Encounter Date:`, `Date of Service:`, `Date of Visit:`, `Date:`, `Visit date:`), so a label-driven extractor needs a synonym set rather than a literal.

The in-body `Visit date:` (158) and `Adm:` (22) counts are **per run**, since grouping keeps only the run's first page's copy. Together they cover 180 of the 188 runs, the rest being runs whose pages carry no date line — an independent corroboration of the run count from a measurement that knows nothing about run detection.

### Dates inside a field's value, not after its label

A third form sits between the two: the field _is_ labelled, but a person's name comes between the label and the date, so no label immediately precedes it. `Electronically signed by: <clinician>, MD on <date> <time>` is the archetype. **1,725 dates (15.9% of the document's) are attributions of this shape** — `<phrase> by[:] <clinician> [on|at] <date>`. **These attribution lines are exactly what the admin strip now deletes** ([strip-admin.ts](../../src/strip-admin.ts)); the table below is the landscape they formed, not what ships.

| Field                       | Dates | Joiner before the date |
| --------------------------- | ----: | ---------------------- |
| `reconciled by`             | 789   | `on`                   |
| `Electronically signed by`  | 249   | `at` 134 / `on` 115    |
| `last edited by`            | 160   | `on`                   |
| `last reviewed by`          | 122   | `on`                   |
| `Filed by:`                 | 116   | none                   |
| `Instance released by:`     | 107   | none                   |
| `Collected by:`             | 94    | none                   |
| `Acknowledged by:`          | 72    | `on`                   |
| `Attestation signed by`     | 8     | `at`                   |
| `Signed by` / `Released by` | 8     | `on` / none            |

The joiner is not a constant — `on` 1,265, nothing at all 575, `at` 146 — and `Electronically signed by` uses **both** `at` (134) and `on` (115) for the same field, so a rule keying on one spelling loses half of it. This is where the unlabelled `on <date>` bucket below comes from: roughly four-fifths of it is attribution.

**These lines are the densest time-of-day carriers in the document**: 85.8% of attribution dates are followed by a time, ≈1,704 stamps — about half of every time stamp in the record. The `reconciled by <clinician> on <date> <time>` line is the same one that puts `0827` on the medication list 706 times.

Separately, a date can sit inside a **quantity** field's value with no person at all: `Refill: 3 refills by <date>` (255), where the label is `Refill:` and the date is the expiry buried in the value.

⚠ **A "nearest `by` phrase" rule misattributes column-paired rows.** `Entered by: <clinician>` is printed beside `Entered on: <date>` with a 17–28 space gutter between them, and the same layout pairs `Discontinued by:`/`Discontinued on:` and `Authorized by:`/`Ordered on:`. The date belongs to the **second column**, and its counts here match the label table exactly (740 and 404), so attributing it to the `by` field would double-count it. 458 such spans were dropped by requiring that no 3-space column gap fall between the person and the date.

### The other half is positional

| Context                                               | Mentions | Share |
| ----------------------------------------------------- | -------: | ----: |
| prose, no recognizable anchor                         | 1,742    | 16.1% |
| after the word `on`                                   | 1,568    | 14.5% |
| inside a table column                                 | 882      | 8.1%  |
| first thing on the line                               | 871      | 8.0%  |
| after a range word (`from`, `to`, `through`, `since`) | 140      | 1.3%  |
| after punctuation                                     | 99       | 0.9%  |

So **any date-consuming rule has to work positionally for half the document** — a label is present often enough to be tempting and absent often enough that a label-only rule sees half the dates. The `on <date>` form alone is 14.5%, which is why the time-stripping anchor keys on the date rather than on any label.

Dates appear alone on 8,863 lines, in pairs on 976, and three to a line on 5 — the pairs being start/end and admit/discharge spans.

⚠ **The label figures come from a 35-character lookbehind**, which can start mid-token and split one label into variants with a short all-caps prefix (`PRN Discontinued on:`, `PM Encounter Date:` after a clock time). Those were folded back into their base label where the base occurs independently. Treat the long tail as approximate; the top of the table is sound.

## Time-of-day mentions

Now **shipped** as the `times` pass ([strip-times.ts](../../src/strip-times.ts)): the record's clinical content does not depend on time-of-day precision, and the stamps are dense. The survey that justified it follows; note that many of these stamps sit on the `reconciled by` / `signed by` lines the **admin** strip now removes outright, so the two passes overlap on the same carriers.

| Format                                  | Count     | Example                                      |
| --------------------------------------- | --------: | -------------------------------------------- |
| `HHMM` military after a date            | **2,409** | `[reconciled by <clinician> on <date> 0827]` |
| `H:MM AM/PM`                            | 653       | `Filed: <date> 11:18 AM`                     |
| `HH:MM` 24-hour after a date            | ~174      | `<clinician>, APRN on <date> 07:51`          |
| `HHMM` after `at`, sometimes + timezone | 112       | `on <date> at 0824 CDT`                      |
| `HH:MM:SS`                              | 2         | ECG timestamps                               |

`0827` alone is **706** of the military times: a single reconciliation event on one morning touched most of the standing medication list, and that one stamp is then reprinted in every later encounter. It appears in two shapes — inline (590×, `<drug> [reconciled by <clinician> on <date> 0827]`) and as a wrapped fragment on its own line (116×, `<date> 0827]`, where the drug name was too long for one line).

The anchoring rule turns out to be exactly right rather than merely safe. Of the 708 lines containing `0827`, **706 carry a date immediately before it** and are caught; the **2** that are not are medication-**administration** lines where the time leads the row (`0827 2 mg Bolus IV push <clinician>`). There the time is the administration time in an MAR table — the one place in this record where time-of-day is clinically meaningful — and the rule declines it by construction.

### Two collisions any rule has to avoid

- **HLA alleles.** `HLA-A *NN:NN` appears 5 times, and a two-digit field pair reads as a valid clock time (an allele like `*07:02` is indistinguishable from 7:02 am). Stripping bare colon pairs would corrupt genomic typing.
- **Unanchored 4-digit numbers are years and doses**, not times: `2025` ×6,010, `2026` ×2,122, `2023` ×509, and `1000` ×134 — the last being `1000 mcg` in a drug name.

Both are avoided by the same rule: **only strip a time that is anchored** — immediately preceded by a date or by `at`. A bare colon pair or a bare 4-digit number is never touched.

There are **no** titers, dilutions or ratio notations in this record. An earlier probe appeared to find 81; they were all real times (`1:24 PM`) clipped by a `1:\d{2,4}` pattern.

### It is cosmetic, not compression

|                         | Total chars | Blocks | Distinct | Recoverable dup |
| ----------------------- | ----------: | -----: | -------: | --------------: |
| as is                   | 1,806,638   | 7,368  | 3,121    | 50.2%           |
| anchored times stripped | 1,787,851   | 7,368  | 3,094    | 50.6%           |

**18,787 chars — 1.0% — and only 27 distinct blocks merge.** Worth doing for readability (2,409 stamps leave the medication entries), not for size or deduplication.

One property that separates this from the chrome work: page-header removal **hoists** furniture, so nothing leaves the file, whereas stripping times **deletes record content** — a time is what the document says, not what the printer added. It ships on by default (no CLI flag; toggled in code), the export's header prose declares the file a compacted interpretation, and the PDF remains the source of truth.

## What the numbers changed

- `dedupe` recovered **3.8%** here: no bookmarks, so it fell back to exact-duplicate whole pages, and it ran on the working copy rather than the OCR-layered `_converted.pdf`, so scanned pages had no comparable text at all.
- Page chrome is found by **measuring the document**, not by authored patterns — see [implementation/text-export.md](implementation/text-export.md).
- The identifier banner is byte-identical across pages **because the bundle is one patient**, which is what lets a frequency rule remove a line carrying a name, an MRN and a DOB without recognising any of them. A multi-patient bundle breaks that assumption.

## Related

- [compact-text.md](compact-text.md) — the optional step these measurements justify
- [implementation/text-export.md](implementation/text-export.md) — the rules and their rationale
- [implementation/dedupe-internals.md](implementation/dedupe-internals.md) — the PDF-level framework, and why it under-performs on this document
- [lessons-learned.md](lessons-learned.md) — working notes from the redaction pass over the same dataset
