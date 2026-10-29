# RAI-DG-02 terminal Provider failure hold — implementation checkpoint

Date: 2026-10-25  
Authorization: `AUTHORIZE_RAI_DG_02_TERMINAL_PROVIDER_FAILURE_HOLD_V2_IMPLEMENTATION`  
Candidate: `81a34c31`  
Decision: **CORE IMPLEMENTATION PASS / QUALIFICATION PARTIAL / CLOSURE OPEN**

## Implemented scope

- P2's existing exact-revision readmission gate now derives
  `TerminalProviderFailureSettlement` from the frozen WorkEpisode
  Execution/Step/ProviderTurn/final ProviderAttempt/Manifest chain.
- Only `AuthenticationFailed`, `RequestRejected`, and `ProtocolViolation` with
  `TerminalFailure + Stop + phase1-v2` qualify. The existing transaction-time
  admission recheck returns `WorkReadmissionHeld` with the bounded source.
- P10 derives the public Attention and Work Detail presentation without a new
  table, marker, event, retry command, WorkWait, or lifecycle transition. The
  validated final Attempt time is read separately in the same projection
  transaction; it is not added to the frozen P2 source DTO.
- Web renders the closed failure code, exact Work revision, and occurrence
  time. It does not add a retry button; recovery remains the existing exact
  revision-advancing Steer operation.
- The release functional manifest includes a real-daemon public-process
  RequestRejected journey covering scheduler ticks, hard restart, Attention,
  Work Detail, and explicit Steer.

No schema or migration changed. Existing terminal evidence remains canonical;
the new hold and presentation are query-derived.

## Evidence on the candidate worktree

| Gate | Result |
|---|---|
| `pnpm lint` | PASS — 1,425 files |
| `pnpm typecheck` | PASS |
| P2 SQLite readmission gate | PASS — 35/35 |
| P10 focused contracts/views/attention | PASS — 83/83 across the focused run after the API-list correction |
| Web Attention/Work Detail | PASS — 41/41 |
| functional manifest validation | PASS — 33/33; 64 Vitest process files and 6 UI files |
| RAI public-process daemon journey | PASS — 1/1; RequestRejected hold survives restart and releases only after Steer |

The full `pnpm check` and complete release-functional suite are intentionally
not claimed by this checkpoint until they run on the committed candidate.

## Paused full-gate run

At the governor's request, `pnpm check` was paused at the next completed core
batch boundary. The run completed lint, typecheck, architecture (37 files,
194 tests), and core batches 1–7 without a failure. Batch 7 completed with
20 files / 89 tests passing; the runner then spawned batch 8 before the
interrupt was delivered. Batch 8 and batches 9–24, aggregate core totals, and
the Web typecheck/build/test tail are **unqualified**. The full gate remains
OPEN and must be rerun or resumed through an evidence-preserving mechanism;
this interrupted console run is not complete-gate evidence.

## Mandatory 15-row qualification status

| Row | Status | Evidence / remaining work |
|---|---|---|
| 1 | PARTIAL | All three closed kinds pass fresh-SQLite source tests; RequestRejected has public-process no-second-request coverage. AuthenticationFailed and ProtocolViolation still need equivalent process qualification. |
| 2 | OPEN | Exact real S2 sequence with prior conversation/tool success has not run on this candidate. |
| 3 | OPEN | The before/after Attempt, Turn, Step, and Execution real-process kill matrix is not yet implemented. |
| 4 | PARTIAL | All three retryable kinds are rejected by focused source tests; eligible retry, budget exhaustion, and deadline exhaustion process branches remain. |
| 5 | PARTIAL | Existing owner regressions were not all rerun as one candidate-bound matrix. |
| 6 | PARTIAL | Missing Step and strict Turn/Attempt/Manifest/taxonomy/time validation exist; the complete duplicate/conflict matrix and public bounded-integrity presentation remain. |
| 7 | PARTIAL | Existing gate scope checks remain green; the complete child/parent/sibling/non-Work matrix is not yet candidate-bound. |
| 8 | PARTIAL | Public Steer `r→r+1` is proven; before/after Steer commit kills and synchronized contention remain. |
| 9 | PARTIAL | Attention/Work Detail and restart are proven; ACK/rebuild/lifecycle and hundreds-row dedup qualification remain. |
| 10 | PARTIAL | The process journey keeps Work Open and adds no retry control; the full negative mutation audit remains. |
| 11 | PARTIAL | Public DTO and Web expose bounded values; full log/result redaction inspection remains. |
| 12 | OPEN | Independent provider request compatibility/reasoning round-trip qualification remains. |
| 13 | OPEN | Focused gates are green, but full `pnpm check`, complete release-functional, package, and real S2 have not all passed on one committed candidate. |
| 14 | OPEN | Two-connection/two-daemon terminal settlement/admission/Steer race is not yet qualified. |
| 15 | OPEN | Retained 617-failure or equivalent hundreds-of-repetitions fixture is not yet qualified. |

Therefore RAI-DG-02 remains **implementation-partial**. This record must not be
used to claim release readiness, real S2 success, or closure of the accepted
V2 qualification matrix.
