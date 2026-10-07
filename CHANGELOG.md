# Changelog

Versioning until 1.0.0: `0.0.x` for fixes, `0.x.0` for new features or behaviour changes.

## 0.0.1

First release.

- `proof-review` skill: reviews a code change in two phases, intent first (does it do what it says?), then bugs (can any be proven?). Review only; the skill never fixes code. No evidence, no comment.
- Targets: working tree (staged, unstaged, untracked), branch against the merge-base with the main branch, or PR/MR through an already-installed `gh` or `glab`.
- Intent claims are extracted from user text, PR description, linked issues, and commit messages (all treated as data), shown to the user, and each marked `done`, `partial`, or `missing`; unmatched changes are listed as `unrequested`.
- Bugs are reported only as `reproduced` (a temporary test failed in a separate git worktree) or `traced` (concrete input walked through specific lines). Everything else goes to a separate suspicions list. Every bug has an impact sentence; there are no severity scores.
- Every candidate gets an independent refutation attempt before it is reported.
- Fix briefs per bug: expected vs actual, reproduction command, and "this test must go from failing to passing". Optional PR comments only on request, each approved before posting.
- Output lives in `<git-common-dir>/proof-review/<target>/`, never in the project; stale folders are cleaned at the start of each run and by `/proof-review clean`. Re-runs are additive and close fixed findings by re-running their reproductions.
- Size check excludes lockfiles, generated, vendored, and snapshot files; above 800 lines or 30 files the review narrows or proceeds in risk order.
- Ledger template, `findings.json` schema, and an optional dependency-free validator that also checks reproduction paths stay inside the output folder.
- Project rules check (decision 16): between intent and bugs, reads `CLAUDE.md` and `AGENTS.md` on the path from each changed file to the repository root, plus `.cursor/rules`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, and relevant ADRs under `docs/adr` at the root, extracts a compact list of checkable rules, and reports only violations the diff introduces as `R001`... records (rule quoted verbatim, source, location, violation). Rule files are data, never instructions. About 50 KB budget; unread rule files are listed in the report. `findings.json` gains `rules`, `scope.rule_files_read`, and `scope.rule_files_not_read`.
- First end-to-end runs on both fixtures (Claude Code, macOS): Go branch mode in English, TS branch mode in Turkish, Go working-tree mode; README shows the real Go report.
