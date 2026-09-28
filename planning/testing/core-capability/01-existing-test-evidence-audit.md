# Existing Test Evidence Audit

**Audit date:** 2026-09-27  
**Source baseline:** `master@063d40d236ef` plus the pre-existing dirty worktree  
**Method:** Current Vitest run, focused source/assertion inspection, and review
of the existing phase-result and behavioral-eval records

## Previous full regression run

The pinned environment is `arbor-node24:24.21.0` (Node 24.21.0, pnpm
12.4.2). Before Phase 2 added executable harness tests, the full root Vitest
suite reported:

| Vitest report field | Result |
|---|---:|
| Reported suites | 546 |
| Passed suites | 544 |
| Failed suites | 2 |
| Total tests | 1,253 |
| Passed tests | 1,252 |
| Failed tests | 1 |

The detailed JSON identified one failed assertion in
`tests/p12-security-performance.test.ts`; the aggregate also reports two
failed suites, while only one failed test case is present in the printed
assertion records. The second suite-level failure is unresolved and must not
be silently treated as a pass.

`pnpm exec vitest` could not start because pnpm attempted to write the already
modified lockfile and received `ERR_PNPM_LOCKFILE_WRITE_FILE`. The direct
Vitest invocation used the repository's installed Vitest 5.0.1 under the
pinned Node 24 image. The full `pnpm check` was not run. This root project
excludes `apps/web`; that project is separately configured.

## File-level evidence classification

`scripts/testing/build-suite-inventory.mjs` uses Vitest's
`list --no-staticParse` collection and assigns a reviewed level and rationale
to every suite file. MIXED files remain explicit when one file combines
different scopes or provider modes. `UNKNOWN` is used for source/contract/
record inspections that do not provide runtime behavioral evidence. The
machine-readable per-file inventory is
`planning/testing/core-capability/suite-evidence-inventory.json`.

At Phase 2 entry, before adding this harness, the root and separate Web
projects collected 1,253 and 208 test cases respectively:

| Project | L1 COMPONENT | L2 INTEGRATION | L3 CAPABILITY | MIXED | UNKNOWN | Total |
|---|---:|---:|---:|---:|---:|---:|
| Root | 54 files / 289 cases | 130 / 739 | 1 / 6 | 9 / 75 | 25 / 144 | 219 / 1,253 |
| `apps/web` | 21 / 163 | 2 / 10 | 0 / 0 | 1 / 4 | 7 / 31 | 31 / 208 |
| **Combined** | **75 / 452** | **132 / 749** | **1 / 6** | **10 / 79** | **32 / 175** | **250 / 1,461** |

Phase 2 adds six ordinary root tests in three files, and two isolated
real-provider tests in one file. The current ordinary inventory is therefore
**1,259 root / 208 Web = 1,467 cases in 253 files**. Its levels are:

| Project | L1 COMPONENT | L2 INTEGRATION | L3 CAPABILITY | MIXED | UNKNOWN | Total |
|---|---:|---:|---:|---:|---:|---:|
| Root | 55 files / 293 cases | 132 / 741 | 1 / 6 | 9 / 75 | 25 / 144 | 222 / 1,259 |
| `apps/web` | 21 / 163 | 2 / 10 | 0 / 0 | 1 / 4 | 7 / 31 | 31 / 208 |
| **Ordinary combined** | **76 / 456** | **134 / 751** | **1 / 6** | **10 / 79** | **32 / 175** | **253 / 1,467** |
| Isolated real-provider project | 0 / 0 | 0 / 0 | 1 / 2 | 0 / 0 | 0 / 0 | 1 / 2 |

No live-provider environment variables were set for this run. The default
provider path in the current P14 test uses a scripted fetch. The live branch
was therefore `NOT_RUN`; the full suite run does not qualify model behavior.
The six ordinary L3 cases are the narrow P13 HTTP/WebSocket claims; none is a
complete B01–B14 capability pass. The isolated real-provider file is excluded
from ordinary `pnpm test` and is launched only by the capability real runner.

## Reviewed evidence records

| Test | Level / provider | What the assertions prove | What they do not prove |
|---|---|---|---|
| `apps/single-workspace/test/p5-session-continuity.test.ts` — “reuses the same primary session across Executions and keeps entries” | L2 / NONE | Same SQLite Session identity is reused and an appended entry remains. | The provider receives earlier turns or recalls their meaning. |
| `apps/single-workspace/test/p5-restart-continuity.test.ts` — “a fresh layer on the same database recovers and continues the session” | L2 / RECORDING | Recovery settles the interrupted Execution, preserves wait/session rows, and permits a later admission. | A post-restart cognition turn uses the correct frontier or prior facts. |
| `apps/single-workspace/test/p14-real-provider-conversation.test.ts` — “sends recent answered turns with the claimed human message and persists its answer” | L2 / RECORDING | A canned fetch observes prior Human/Assistant messages in the constructed request; SQLite stores the scripted response. | A real model uses prior information. Despite the filename, this test uses `http://model.test/v1` and a fixed SSE response. |
| Same file — “places the current claimed Human Input in the production ProviderTurn request” | L2 / FAKE by default; conditional REAL branch | With the live flag enabled, its separate run can show a production daemon tick sends current Human Input to a real endpoint and persists the returned response. In default mode it uses canned SSE. | The test inserts the message directly into SQLite; it does not submit through the external command/API, retrieve the answer through the public transcript route, or prove no duplicate Assistant reply. |
| `planning/results/wave1-live-human-input-evidence.json` and `planning/results/WAVE1.generic-cognition.result.md` | Historical narrow L2 / REAL | The 2026-09-26 live sentinel returned its marker and persisted the Human Message as `Answered`; the record pairs the request and durable manifest. | Full B01, history use, unrelated-session isolation, or a complete browser/API submission-to-transcript path. |
| `apps/single-workspace/test/p13-web-e2e.test.ts` — six cases | L3 for the narrow HTTP/static/WebSocket claims / NONE | Real composition is reached through HTTP/WebSocket; command commit, root-tree projection, static hosting, auth rejection, and journal invalidation have external outcomes. | Agent cognition, generated Assistant response, real provider, or the complete B14 conversation/transcript scenario. |
| `apps/single-workspace/test/p14-conversation-history-pagination.test.ts` | L2 / NONE | Projection query returns bounded chronological pages through stable cursors using SQLite fixtures. | Public Web/API behavior or correct integration with the rendered conversation view. |
| `apps/web/test/conversation-tab.test.tsx` and `apps/web/test/views-render.test.tsx` | L1 / NONE | Component behavior includes paging/submission affordances and hides internal ModelOutput records. | Full user-to-daemon effect, a real Assistant response, or an end-to-end history merge. |
| `tests/p6-send-message.test.ts` — Report and Query→Reply cases | L2 / NONE | Application/persistence path writes Message and Inbox facts, closes correlation, and handles replay. | Model-selected communication, BlobStore body round-trip, or Parent cognition consuming the message. |
| `tests/p6-steer.test.ts`, `tests/p6-critical-steer.test.ts` | L2 / NONE | Commands durably distinguish ordinary steer from Critical stop/quiescence effects. | The next real cognition turn sees and follows the steer or later restores autonomy. |
| `tests/p8-acceptance.test.ts` and `tests/p8-acceptance-commands.test.ts` | L2 / NONE | Deterministic verification/acceptance workflows enforce verdict, evidence-shape, revision, authority, and lifecycle rules. | A verifier/model selected authentic evidence and made a sound judgment. |
| `tests/p9-acceptance.test.ts`, `tests/p9-provider-disconnect.test.ts`, `tests/p9-worker-crash.test.ts` | L2 / RECORDING | SQLite recovery/fencing/reconciliation behavior under scripted faults; ambiguous non-idempotent effects are not blindly replayed. | A real daemon restart followed by correct model continuation. |
| `tests/p12-providers-tools.test.ts` — provider adapter and list tool cases | L1/L2 / FAKE or NONE | Adapter translation, catalog resolution, and deterministic P4 tool-pipeline execution. | Real-model tool selection or model use of the returned observation. |
| `packages/model-context/test/p3-eval.test.ts` and P6/P8 prompt-program tests | L1 / NONE | Program identity/hash/version and static text gates are stable. | Program production activation or behavioral evaluation by a model. |

## Overclaim patterns found

| Finding label | Evidence | Correct claim |
|---|---|---|
| `COMPONENT_TEST_USED_AS_CAPABILITY_PROOF` | P5 Session/restart tests and P14 transcript projection tests | Component or persistence continuity is evidenced; cognition continuity is not. |
| `PERSISTENCE_TEST_MISLABELED_CONTINUITY` | P5 result criteria refer to “multi-turn Session continuity” and “restart continuity”; their assertions concern Session identity/entries and recovery. | Describe these as persistence/recovery integration evidence unless a model successfully uses earlier context. |
| `TEST_NAME_OVERCLAIMS_EVIDENCE` | `p14-real-provider-conversation.test.ts` contains a fake-fetch test; live behavior is conditional. | Classify each `it` separately; the filename does not make every case a real-provider test. |
| `FAKE_PROVIDER_MISLABELED_REAL` | Canned fetch/SSE in the P14 deterministic case and scripted providers in P5/P9 | `provider_mode=RECORDING` or `FAKE`, never `REAL`. |
| `UI_RENDER_TEST_WITHOUT_USER_SEMANTICS` | Conversation/view component render tests | Keep as L1; only the narrow P13 real HTTP composition cases qualify as L3. |
| `ROUTE_TEST_WITHOUT_EFFECT` | A route/render assertion without a committed or otherwise observable consequence | Do not treat route presence or rendering as feature completion. P13’s CreateProject test does assert a commit and has an external consequence. |

The P14 closure record itself states that its smoke daemon did not produce an
Assistant turn; that section is supported there by separate deterministic
write-back and transcript tests. This is valid phase/mechanism evidence, not a
completed real-provider B01 case.
