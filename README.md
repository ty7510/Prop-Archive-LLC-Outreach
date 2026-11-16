# Prop Archive Outreach

Finds Philadelphia landlords who fit Prop Archive's ideal customer, enriches every reachable
channel, and runs outreach that books demos and beta sign ups. One password, four screens
(Leads, Sequences, Settings, Go), one switch.

Spec: [docs/SPEC.md](docs/SPEC.md). Setup and daily use: docs/RUNBOOK.md (written with the build).

## Versions

Every finished piece of work is a tag on `main` with a GitHub release that lists its pull requests.
`git checkout v0.5.0` is the code as that milestone left it.

| Tag    | Merged                   | Pull requests | What it holds                                                                         |
| ------ | ------------------------ | ------------- | ------------------------------------------------------------------------------------- |
| v0.1.0 | 2026-10-11               | #1 to #12     | The system: lead sources, enrichment, sequences, autopilot, screens and seeded copy   |
| v0.2.0 | 2026-10-11 to 2026-10-12 | #13 to #23    | Runs on Replit; enrichment proves every contact; Claude key from the workspace secret |
| v0.3.0 | 2026-10-13 to 2026-10-14 | #24 to #35    | Outreach runs by itself; Gmail through Sign in with Google; readiness checks          |
| v0.4.0 | 2026-10-14 to 2026-10-15 | #36 to #39    | Claude Haiku for every call; LinkedIn goal of 25 notes a day                          |
| v0.5.0 | 2026-10-16 to 2026-10-17 | #40 to #44    | No automatic email: LinkedIn notes, the to-do list, printouts and hand-sent email     |
| v0.6.0 | 2026-10-19 to 2026-10-21 | #45 to #57    | Today tabs; the to-do list fills from Enrich; LinkedIn name match                     |
| v0.7.0 | 2026-10-24 to 2026-10-26 | #58 to #64    | Envelope labels and the two-page printout                                             |
| v0.8.0 | 2026-11-04               | #65 to #67    | Export leads as CSV, select all pages, CI checks only what changed                    |

## Pull requests, labels and tags

- Title: one plain sentence that says what changed for the person using the app.
- Labels: `enhancement`, `bug` or `documentation`, plus every area the change touches: `area:server`,
  `area:client`, `area:db`, `area:infra` (CI, Replit, scripts) and `area:copy` (outreach wording).
- When a piece of work is finished, tag the merge commit of its last pull request with the next
  minor version (`v0.9.0` is next; fixes to a milestone are patches), publish a release that lists
  the pull requests, add a row to the table above and set `version` in `package.json` to match.
- A tag that has been pushed is never moved or made again.
- The "Published your App" commits on `main` come from Replit's Publish button; they carry no
  pull request and need no label.
