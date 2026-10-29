# Full Delivery Integration Ledger

**Candidate base:** v19 exact `0f277366f15ef7f10e36dee6b6c536c5785d4c13`.
**Worktree:** `C:\Users\ThinkPad\.codex\worktrees\full-delivery-integration\Arbor`.
**Purpose:** record source-to-integration provenance and qualification limits.
No `docs/design/**` semantics were added beyond the already accepted AH7
landing. No Vitest, daemon, browser, or full release suite was run here. Static
verification after all source merges: `pnpm typecheck` PASS; `pnpm lint` exit 0
after checking 1,065 files, with one pre-existing warning at
`packages/agent-runtime/src/model-decision.ts:4070` (`noNonNullAssertion`).
Working-tree `git diff --check` is clean. A base-to-head whitespace scan also
reports trailing spaces in inherited historical planning/proposal/result
records; those source artifacts were preserved byte-for-byte.

| Source SHA | Integrated SHA | Integrated content and evidence | Still pending / qualification limit |
|---|---|---|---|
| P37 ancestors `800d71c`, `ad30b1c`, `72e578f`, `7e3f1d4`, `d578cb4`; final `c816633` | `60b122b` (merge, complete ancestry retained) | L6 unchanged process matrix 11/11 PASS across rerun 3's eight observed cases plus rerun 4's remaining three, and F19 forward/reverse public delivery 2/2 PASS, all no-retry. L6 test moved from `pending/` to default `process/` discovery. The summary is `planning/results/P37-L6-process-crash-matrix.result.md`. | Split-run qualification, not one uninterrupted 11-case run. Source raw logs and DB/SHM captures are ignored artifacts and were not imported into this worktree. Full `pnpm check`, full `pnpm test:functional`, F20 and full release qualification remain open. No local Vitest/daemon run was performed during integration. |
| `28f9c4f` accepted AH7 owner landing; `6e0faf53` independent review | `413857f` (merge) | Accepted owner-boundary contract landing plus independent review. | This design landing does not itself close AH7; use the separate classification row for qualification evidence. |
| `68c9605cadd179a6438b3e1051ebc3c656f44d0f` AH7 test classification | `b0e2765` (merge, full ancestry retained) | The accepted classification moves copied-holder runtime tests/config to diagnostic-only names and adds default Store tests. Source result records accepted-baseline G0/G1 + live-lease process qualification 2/2 (zero retry, 39.66s), Store suite 3/3, source typecheck/lint/targeted Biome PASS. | The 3-file/6-test diagnostic run had 5 PASS/1 RED before removal of the duplicate Store case; it is not a diagnostic PASS. The remaining five strict Runtime diagnostics were not rerun after that non-oracle deletion. Final independent central full gate remains outstanding. |
| `2d1cf72`, `b2d0903`, `5b3e3bb`, `a921ac0` P38 process source | `3ff4f03`, `d7fde19`, `7126199`, `ce9d755` | Corrected final two-daemon claim/effect crash scenarios, one-approval uniqueness, and marker after successful effect. The source result `f9baa0a` was integrated as `af8ceb6`: claim-commit→crash and effect→crash each PASS 1/1, zero retries, on `a921ac0`. P38 remains OPEN. | These are targeted process cases, not full `pnpm test:functional` or release qualification. The P38→P39 receipt projection draft remains unaccepted and P39 is not integrated. |
| `688e6a5` Stop/TTL resolution order | `0aa680e` | SQLite Stop-first and expiry-first orderings PASS 2/2 on source branch. | Deterministic ordering tests do not establish simultaneous cross-process contention or all approval lifecycle outcomes. |
| `55712dd`, `6dd6f90`, `cf47d1f`, `327298e` cumulative migration fixture | `07af7f7`, `1cdde9a`, `40ce4e0`, `f223bde` | Enhanced disposable cumulative 0037→0038 fixture PASS 1/1 with no retries; validates source version/high-water 37, destination fields, approval preservation, 0033 FK, FK check, indexes and no-op re-entry. Source result/raw are retained. | In-memory adapter fixture only; not deployment, preserved-database, runtime, or release qualification. The legacy consumed-Control negative failure reason is still pending. No production migration SQL changed. |
| `6459920` F23 decoder/default-process test source | `7380944` | Strict result-shape and prior-version unit test source plus default process wrong-shape receipt cases and audit record retained. | The source's two-file Vitest run was interrupted after 27 tests printed; it is **not PASS**. F23 cases require central qualification. `F21-open1-open2-closure-decision-draft.md` remains a draft, not accepted governance. |
| `74960eb` full delivery matrix correction; `2591267` S1–S4 matrix | `8118fbe`, `29bf6c3` | Audit matrices retained as historical snapshots and annotated with current integration status. | Matrix claims are not test evidence; use the qualification limits recorded there and in this ledger. |

The final frozen integration SHA is reported with the handoff; the branch is
`codex/full-delivery-integration`.

## Explicit exclusions and current handoff

- P37 qualification is now integrated at `c816633` with its complete source
  ancestry. Rerun 3 was interrupted after eight cases; rerun 4 passed the three
  remaining cases and F19 passed 2/2. This is recorded split-run evidence;
  full functional/release qualification is still required.
- AH7's accepted classification is integrated from `68c9605` with full
  ancestry. Count only the named 2/2 process and 3/3 Store results; preserve the
  diagnostic 1 RED and do not call the remaining diagnostic run qualified.
- P39 maintenance commit `79c703f` and related source are not fully tested and
  do not register migration 0039; they were not integrated. P40/P41 source was
  not prefix-qualified and was not integrated.
- The full-delivery and S1–S4 matrices retain the prior baseline audit and add
  a dated status note for this integration. They must not be read as claims
  that the current candidate has passed full gates.
- Allowed static verification for this integration is limited to typecheck,
  targeted Biome, and whitespace/diff checks. The P37 owner has the exclusive
  heavy test window; no Vitest, daemon, or full suite was started here.
