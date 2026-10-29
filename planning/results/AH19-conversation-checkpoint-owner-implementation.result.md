# AH19 Conversation Checkpoint Owner implementation result

Date: 2026-10-18
Implementation worktree: `C:\Arbor-ah19-conversation-0048`
Base at start of implementation: `cafcf0f14fe6a6d3b4a38cbbbf1a6d049e4bf4aa`
Design authority: accepted AH19 P17-authority reconciliation and landing already present in the base history. No `docs/design/**` files were changed in this implementation.

## Delivered

- Added offline-only migration 0048, requiring schema 47, and a RootWorkspace-owned `ConversationCheckpointOwner` store with epoch/frontier compare-and-set. The 0047 prefix remains unchanged; upgrade paths include 47→48, 46→48, and ordered 44→48, with descriptor, manifest, resume, and no-op validation at target 48.
- Added P17-authoritative projection: immutable HumanMessage identity/body/order plus exact ResponseJob, Attempt, Episode-admission transition, and completed Execution evidence. Answered sources form a contiguous prefix; the current Running Job/Attempt/Execution is pinned once and excluded from the answered frontier. Historical HumanMessage lifecycle/claim/response columns do not determine owner state.
- Added portable Summary / ProviderNative continuation handling. Native opaque state is reused only for exact binding; mismatch rebases through portable Summary without forwarding the old opaque reference. Summary Blob is written before owner CAS; an orphan Blob on CAS conflict is allowed. Conversation owner epoch does not mutate the Work Session epoch.
- Added process-crash qualification on both sides of owner commit, exact Native binding match and mismatch process cases, owner CAS competition, legacy-field/migration preservation, P14 provider-source coverage, and module-level projection, epoch, compaction, binding, and migration/store tests.
- Added stable composite Conversation compaction ProviderTurn IDs consistent with the existing compaction identity convention. The generated ID and its exact execution/session/epoch/frontier/admission binding are asserted in a focused unit test.
- Updated schema-upgrade CLI and P39 continuation/no-op adapter to final target 48. Registered 53 functional Vitest files and 6 UI files.

## Verification

| Check | Result |
|---|---|
| Focused migration/store/projection/session-epoch/binding/compaction/P14 module batch | 7 files, 24 tests PASS (133.24s), before the final generated-ID assertion was added |
| Compaction generated-ID and owner-CAS unit file, after final ID fix | 1 file, 2 tests PASS |
| Owner checkpoint real-process crash boundaries | 1 file, 2 tests PASS (64.57s) |
| Native binding exact-match real-process case | 1 file, 1 test PASS (46.44s) |
| Native binding mismatch → portable Summary real-process case | 1 file, 1 test PASS (54.46s; test 30.79s); verified B requests contain no old opaque ref |
| Offline CLI 44→48 | 1 case PASS (111.50s) |
| Offline CLI 46→48 through ordered 0047+0048 prefix | 1 case PASS (81.37s) |
| Offline CLI 47→48 and resume-copy no-op | 1 case PASS (98.12s) |
| Fresh schema-48 target | 1 case PASS (135.70s) |
| Native-binding selector unit matrix | 4 tests PASS |
| `pnpm build` (`tsc -b`) | PASS |
| `pnpm exec tsc -p tsconfig.test.json` | PASS |
| `pnpm exec biome check` | PASS; checked 1,226 files |
| `git diff --check` | PASS |
| `node scripts/testing/check-manifest.mjs` | PASS; 53 functional Vitest files, 6 UI files, 62 manifest paths |

The mismatch process case initially exposed a real runtime failure: after exact binding mismatch correctly selected portable Summary, the Conversation compaction path passed a stable composite provider-turn ID through the strict UUID-only parser, terminating the child before any B provider request. The code now constructs the deterministic composite ID using the same typed identity convention as existing compaction paths. The added unit case checks determinism and the exact manifest binding; the rebuilt real daemon then passed the mismatch case.

## Independent-review correction

The first independent implementation review identified a fail-open for a persisted unknown `checkpointKind`: the SQLite owner shape validator treated any non-Native kind as Summary, while projection did not reject an unknown manifest kind. Because runtime consumes only Summary and ProviderNative, this could advance the frontier without supplying either checkpoint, silently omitting covered conversation history. The implementation was corrected before final handoff:

- Added shared ports validators for the exact `Summary | ProviderNative` enum and checkpoint/ref/fingerprint combination. Store owner read/write, projection owner+manifest parsing, and model-decision consumption now use the shared validation. Summary refs must be 64-character lowercase content digests; Native refs must be non-empty and have the exact binding fingerprint.
- Added negative cases for corrupt persisted owner kind (including a test-only SQLite CHECK bypass), unknown manifest kind, Native missing fingerprint/ref, Summary wrong ref, and malformed commit inputs.
- Focused store/projection/compaction batch after the correction: 3 files, 21 tests PASS (64.10s). Native binding mismatch real-process re-regression after rebuild: 1 file, 1 test PASS (30.33s); no prior opaque ref was sent to binding B.
- Follow-up `pnpm build`, `pnpm exec tsc -p tsconfig.test.json`, `pnpm exec biome check` (1,226 files), `git diff --check`, and manifest validation (53 Vitest / 6 UI / 62 paths): PASS.

## Scope limits

The full `pnpm check` and full `pnpm test:functional` suites were not run. Production implementation, focused tests, migration/CLI work, manifest, and this result remain intended for one implementation commit; independent implementation review is still required.
