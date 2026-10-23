# Real S2 Immediate-Stop Journey — Terminal Self-Wait Evidence

Date: 2026-10-24  
Status: **EARLY_ABORTED_TERMINAL_BUSINESS_SELF_WAIT; not PASS and not a normal Vitest FAIL**  
Journey: real configured public S2 immediate-stop (`S2-STOP-1805367C09`)  
Test source SHA: `9e66e8d4b3272348cb554dbcd527b47529d2ce98`  
Design Gap candidate: `S2-WDG-01` (producer Wait eligibility; diagnosis only)

## Run boundary

One fresh, test-owned real-provider fixture was started in the isolated
`real-public-s1-qualification` worktree using
`vitest.public-real.config.ts`, the exact immediate-stop test selection,
retry=0 and one worker. The configured provider file was selected by path but
its contents and any credentials were never printed. The run did **not** reach
the stop boundary, did not submit public `StopExecution`, and did not restart
the fixture. It was stopped after durable terminal evidence proved the test's
post-effect/active-Execution precondition was no longer reachable.

The test created a natural human objective in its fresh Workspace: create the
test-owned file
`immediate-stop-s2-stop-1805367c09.txt` with one exact initial line, then read
it back. No prompt was reissued and no model response was replaced.

## Public outcome and exact terminal cause

The private capture shows **3 real Provider requests started and 3 completed
with HTTP 200**; request sequence 3 matched the bounded Work selector, was
held after the real upstream response, and released using the same request ID.
There were zero transport failures. The public read-only
`POST /views/current-work` returned the target Work as `Open`, revision 0, and
without an active Execution. The test workspace contained only the original
`proof.txt`; the objective's target file had not been created. Public
`StopExecution` was not submitted.

Read-only inspection of the isolated disposable DB established the exact
terminal state:

| Fact | Value |
|---|---|
| Current Work | `wrk_492f95d2-11a2-7d19-81db-9188f9aabad2`, Workspace `ws_4dd5097e-58e5-7f2e-81f8-782a44161b17` |
| Work lifecycle/revision | `Open`, revision `0` |
| Work Execution | `exe_4db6afa0-7850-7c76-847d-d83204cd16a1`; settlement `Completed`; settled at `2026-10-23T16:35:27.998Z` |
| Execution result | `Completed(Yielded)` |
| Provider turns | 1; its only turn finished with `ToolCall` |
| ToolInvocations / file effects | 0 |
| Durable WorkWait | mode `Any`; condition `VerificationChanged(workId=wrk_492f95d2-11a2-7d19-81db-9188f9aabad2, targetWorkRevision=0)` |
| Exact Open Verification for that Work/revision | none |
| Exact CompletionClaim / P8 consumer source for that Work/revision | none; the Work Execution settlement was `Yielded`, not `CompletionClaimed` |
| Acceptance | none |

The persisted Wait is a self-wait: independent Verification is only started
from a durable producer `CompletionClaimed` settlement. This WorkExecution
settled `Yielded` before any CompletionClaim or file effect, then parked on a
VerificationChanged condition for the same Work/revision. No exact verification
or P8 consumer source could later satisfy it. Therefore no active Work
Execution could reach the test's required post-effect Stop boundary. This is a
terminal business outcome for this particular attempt, not a slow Provider,
missing approval, or held-response leak. It is separate from the earlier
Normal Steer mission mismatch documented in
`S2-steer-work-revision-design-gap.result.md`.

## Retained artifacts and process cleanup

All raw provider request/response capture and the fixture remain under the
P39-private, uncommitted run/evidence paths below. Raw capture includes model
context and must not be copied to this report or committed. The capture records
no Authorization header or credential value.

```text
.test-results/real-public-s2-stop-1805367c09-8wqCuS/evidence-SAXVgV/
.test-results/real-public-s2-stop-1805367c09-8wqCuS/evidence-SAXVgV/provider-captures.jsonl
.test-results/real-public-s2-stop-1805367c09-8wqCuS/evidence-SAXVgV/EARLY-ABORTED-TERMINAL-SELF-WAIT.json
.arbor-functional-schema44-NohoFK/fixture-914TQV/
```

| Private artifact | Bytes | SHA-256 |
|---|---:|---|
| `provider-captures.jsonl` | 707,468 | `3ED1E6F11326E1A718CD845592751340B47B4F57EFE406A2D7B9754A289EA0EA` |
| `EARLY-ABORTED-TERMINAL-SELF-WAIT.json` | 2,141 | `F636ACBAAFED391E38D259DD929FFB1E262339208693DC3E1890EBA615E02FB9` |
| retained disposable `arbor-functional.db` | 1,445,888 | `3F11C22B831A0C78BDD364394A00157C1DBCB9C3F5C068280340F9E0EBA4675D` |
| preserved workspace `proof.txt` | 19 | `D1574F67AE06C81C6988C3ECCEC572C403A0602DA3DB45EA6F3FCAA431B18514` |

Exact test-tree process IDs were `21688 → 11548 → 24496 → 23004 → 20764 →
29016 → 13528`; all seven were stopped leaf-first after fixture/capture
preservation. Recheck found zero remaining owned PIDs, zero matching
non-shell `vitest.public-real` / `real-public-s2-stop` processes, and no
remaining owned daemon listener on port 57215. Session 85824 terminated.

## Claim limits

This record is not evidence that immediate-stop behavior passed; the public
stop was never issued. It does establish that an unqualified same-Work,
same-revision VerificationChanged Wait can settle/park a WorkEpisode despite
no exact Open Verification or CompletionClaim consumer source. A deterministic
eligibility guard is proposed for separate contract analysis; no implementation
or test was changed by this evidence record. The retained DB/captures are
disposable local evidence only and are not committed.
