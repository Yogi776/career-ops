# India / United States market skills analyzer

`market-skills.mjs` is a local-first market-analysis extension for this fork.
It collects a configured sample of public ATS boards, normalizes listings,
counts skill mentions by country and experience, and saves replayable reports.
No model, credentials, application automation, or personal CV is needed.

## Quick start (offline)

Use Node.js 24 (validated on 24.22.1), or a version supported by `package.json`.
This command's dependency closure uses only Node built-ins and existing modules;
there is no new npm dependency and no browser installation is needed.
From the repository root:

```bash
node --test tests/market-skills.test.mjs
node market-skills.mjs --fixtures tests/fixtures/market-skills/ats.json --as-of 2026-10-26 --out output/market-demo
```

All companies, jobs, dates and responses in this fixture are synthetic. The
fixture invokes the real Greenhouse, Lever and Ashby provider parsers with an
injected HTTP context; any URL absent from the fixture fails rather than going
online. Expected result: **10 observations, 1 duplicate removed, 9 jobs**, all
three boards successful. The default output without `--out` is
`{DATA_ROOT}/reports/market-skills/{as-of}/`, using `path-resolver.mjs` and its
existing environment/marker-file precedence. An explicit `--out` is relative to
the current working directory. Reusing an output directory replaces the six
report files; use a separate directory per collection to retain history.

## Public ATS collection

Create a user-owned `data/market-boards.json` with the boards you intend to
include. These are placeholders, not verified employers or working board IDs:

```json
{
  "boards": [
    { "provider": "greenhouse", "board": "REPLACE_WITH_BOARD_SLUG", "name": "Employer name" },
    { "provider": "lever", "board": "REPLACE_WITH_BOARD_SLUG", "name": "Employer name" },
    { "provider": "ashby", "board": "REPLACE_WITH_BOARD_SLUG", "name": "Employer name" }
  ]
}
```

Use the board slug from the employer's public ATS careers URL. Remove unneeded
entries. Then run, setting `--as-of` to your reporting date:

```bash
node market-skills.mjs --config data/market-boards.json --as-of 2026-10-26 --out output/market-2026-10-26
```

The analyzer reuses `providers/greenhouse.mjs`, `providers/lever.mjs`,
`providers/ashby.mjs`, and `providers/_http.mjs`. Requests are sequential and
retain existing transport timeouts, provider retries and host/IP safeguards.
Only those three public API providers are enabled in this first version.
Arbitrary API URLs, plugins, browser fallback and executable parsers are not
accepted. Workday and regional Lever EU boards are future adapters, not enabled
by this CLI. LinkedIn scraping is neither implemented nor assumed authorized.
Evaluate access and terms separately before adding it.

A successful collection means the board API returned a listing, not that a
candidate has independently verified it is still open. A failure is reported as
`status: error`, never disguised as zero jobs. Unexpected response shapes also
fail visibly. Existing optional Greenhouse office enrichment may warn and retain
a work-model-only location; that location remains unknown.

## Replay and posting-date filters

```bash
node market-skills.mjs --input output/market-demo/snapshot.json --as-of 2026-10-26 --out output/market-replay
node market-skills.mjs --input output/market-demo/snapshot.json --as-of 2026-10-26 --from 2026-10-20 --to 2026-10-24 --out output/market-window
```

With the same snapshot, code revision, Node/ICU version, report date and filters,
replay produces identical report bytes. Save the snapshot and code commit for
reproducibility. A SHA-256 digest of the parsed snapshot's JSON is included in
`report.json`. `--as-of` is a required report label, not a claim that imported
postings were fetched on that day. It does not implicitly filter postings.
`--from` and `--to` are inclusive UTC posting-date bounds; missing/invalid dates
are retained when no window is specified and excluded when a window is set.
The bounded fixture example yields **6 jobs**. No date is invented from fetch
time, a title, or an employer's last update.

## Output contract

| File | Contents |
| --- | --- |
| `snapshot.json` | Provider-normalized observations, source outcomes, schema version and collection mode; input for replay |
| `report.json` | Normalized jobs, experience evidence, grouped counts, skill frequencies, source coverage, rejected-row reasons, input digest and reporting window |
| `jobs.csv` | One row per unique included listing, normalized fields and skills |
| `job-counts.csv` | All nine country/experience buckets, including zero counts |
| `skills.csv` | Skill, number of listings mentioning it and percentage of listings within the country/experience bucket |
| `sources.csv` | Board/provider, fetch outcome, raw count, included unique count and error |

All CSVs carry reporting date and window columns, use quoted UTF-8 fields with
CRLF records, escape embedded quotes/newlines, and neutralize spreadsheet
formula prefixes. JSON preserves original text. Source counts can overlap if
multiple boards expose the same canonical URL; sum global counts from
`job-counts.csv`, not `sources.csv`.

Exit status: `0` complete collection/analysis, `1` invalid arguments/input or
fatal write error, `2` report written but partial because a board failed or rows
were rejected. A successful empty board has status `ok` and zero counts.

### Normalized listing

- `jobId`: SHA-256 of a stable provider/board/posting identity, falling back to
  canonical URL when no posting ID is exposed. `postingId` retains the native
  identifier (nullable), with `identityKey` retaining its provider/board scope.
- `company`, `jobTitle`, `sourceUrl`, `source`, `board`, `location`.
- `country`: `India`, `United States`, or `unknown`.
- `experienceRequirement`: category, numeric minimum in years (nullable),
  matched evidence and reason. `experienceCategory`: `fresher`, `experienced`,
  or `unknown`. `seniorityCategory`: a separate title hint (`entry`, `senior`,
  `unknown`) that does not determine experience category.
- `postingDate`: UTC ISO timestamp or null; `description`: text returned by the
  provider; `extractedSkills`: unique canonical technical-skill labels.
- `sources`: contributing provider/board keys; `duplicateObservations`.

### Classification and counting policy

Country assignment requires explicit country names or supported country-code
tokens in the location. City-only, state-only and remote-only strings remain
unknown. Both India and US in the same location, or a recognized foreign country
alongside a target, remain unknown; a multi-country role is never counted twice.
Country-name recognition uses Node's English ICU region names and deliberately
favors unknown on conflicts (for example Georgia can be a country or US state).
Not every geographic spelling or multi-location phrase is understood.

Fresher means **explicitly zero-experience eligible**, including `0-2 years of
experience`, `no prior experience required`, or `freshers welcome`; it does not
mean exclusively for freshers. A positive numeric minimum is experienced.
Preferred/desirable experience and upper bounds do not establish a minimum.
Conflicting explicit no-experience and positive requirements yield unknown.
English rules recognize numeric year/month requirements next to `experience`;
word-number, alternative-degree, non-English and complex prose can remain
unknown. Junior/senior titles alone never establish a numeric requirement.

Skills come directly from `skill-extract.mjs` and its shared canonicalization,
the same foundation used by `jd-skill-gap.mjs`. Each skill counts at most once
per unique listing, regardless of repetition. Frequencies describe **mentions**,
not guaranteed mandatory skills: negation, preference and proficiency are not
semantically resolved. Empty descriptions contribute to the job denominator
and a visible missing-description count, but produce no skills.

Deduplication uses the shared `url-key.mjs` normalizer and stable provider +
board + posting ID keys. It does not fuzzy-merge jobs merely because company and
title match. Connected URL/ID aliases merge transitively. The richest description
wins deterministically, skills and source attribution are unioned, and conflicting
known countries/experience categories become unknown. Same-title postings with
different IDs and URLs survive. Cross-ATS reposts without a shared canonical URL
remain separate; contradictory duplicate dates use the chosen representative's
date. This is snapshot deduplication, not a longitudinal repost detector.

## Scope and limitations

This is an auditable, deterministic foundation for an AI product, not an LLM
agent. It does not rank candidates, infer candidate skills, send applications,
or compute personalized skill gaps. A later component can join canonical market
skills to a consented candidate profile using the existing gap logic.

These reports describe only configured boards and collected descriptions, not
an unbiased estimate of the whole India/US labor market. Employers, role mix,
date availability, failed sources and missing/truncated descriptions affect
counts. Greenhouse and HTML-derived Lever descriptions inherit the existing
provider's 4,000-character text cap; skill and experience evidence beyond the
cap can be missed. No extra scraper is added to fill those gaps.

All generated observations/reports are user data. The analyzer is registered in
`SYSTEM_PATHS`; tests and docs use their existing system directories. Personal
tracker, pipeline, scan history, CV and profile files are not read or changed.

## Validation

```bash
node --test tests/market-skills.test.mjs
node test-all.mjs --only market-skills
node test-all.mjs
```

The first command is credential-free and covers provider parsing, ambiguous
geography, experience evidence, aliases, ID/URL deduplication, date windows,
missing data, failed/empty sources, schema validation, CSV safety and byte-for-byte
CLI replay. The new suite is automatically discovered under `tests/`.

Implementation validation: 41 analyzer tests passed under Node 24.22.1.
The full repository suite and live ATS requests have not been validated in the
restricted implementation environment; run the full suite in a complete checkout
before merging. Synthetic results are not current job-market findings.
