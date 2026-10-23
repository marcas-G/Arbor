# S2 SteerWork / VerificationMission Revision Gap — Failure Evidence

Date: 2026-10-24  
Classification: **REAL PUBLIC S2 NORMAL STEER TERMINAL BUSINESS FAIL; design gap raised; no fix/qualification claim**  
Design Gap: `S2-RDG-01`  
Proposal: [`planning/proposals/S2-steer-work-revision-contract-governance-draft.md`](../proposals/S2-steer-work-revision-contract-governance-draft.md)  
Source/test baseline: `9e66e8d4b3272348cb554dbcd527b47529d2ce98` (isolated worktree). Frozen owner baseline includes DID v1.58 / P8 F18 Verification v2; this S2 gap concerns new Work revision authoring and does not alter historical v2 mission/criteria/receipt/wake snapshots.

## Run boundary and evidence preservation

One configured **real-provider** public S2 Normal Steer case ran against a fresh
test-owned DB/workspace in the isolated `real-public-s1-qualification` tree.
The run was not a fake-provider test. Retry count was zero; the Stop case was
not started. The harness stopped after observing the terminal business result;
it did not produce a normal Vitest FAIL report because its then-current
verification waiter accepted only PASS and would otherwise await the journey
deadline. Thus this is recorded as a real terminal Verification FAIL, not as a
green qualification or a normally completed Vitest failure.

The private P39 evidence root is:

```text
.test-results/real-s2-normal-9e66e8d4-9DuzuI/real-public-s2-normal-3b7d3621f7-I1uBCj/evidence-SrmPWr/
```

It retains `EARLY-ABORTED-TERMINAL-VERIFICATION-FAIL.json`, the raw
`provider-captures.jsonl`, and a copy of the exact fixture under
`retained-fixture-3w9gX4/`. These are private, uncommitted test artifacts and
must not be copied into this planning record or committed. No Authorization
header or credential value was captured in the provider capture. Sensitive
request/response bodies remain only in the P39-private local artifact. The
fixture and evidence are intentionally retained for diagnosis; no live/user
database or project was used. The owned Vitest/worker/daemon process tree was
cleaned and independently checked; no matching non-shell process remained.

Hashes for re-identifying the retained evidence without reproducing its
contents:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `provider-captures.jsonl` | 12,363,012 | `EC1415CF387428F33AE9A9652898A6B78473FA7D7CE2A0E66F4FB80148988245` |
| `EARLY-ABORTED-TERMINAL-VERIFICATION-FAIL.json` | 1,363 | `41EE04F8CF314AA3B5FF3F465F057CBF37A25E07BC9B2988417EDA1CF9189742` |
| retained disposable `arbor-functional.db` | 4,104,192 | `A80DC985CD5DED5AE1C7DD16D72D6ED90A709D4B2B892DA1ED8CD477DF6DD0B4` |
| produced file | 33 | `C8104834E6BC4086E0ACCDF6D85FFC5EAAEA05D2742B6CB66655E40EA97C129F` |

## Exact public journey facts

The submitted human goal required the test-owned workspace file
`normal-steer-s2-normal-3b7d3621f7.txt` to contain exactly one line:

```text
S2 initial S2-NORMAL-3B7D3621F7
```

After the exact Work approval and public Normal `SteerWork`, the human steer
asked for the same file to contain exactly:

```text
S2 corrected S2-NORMAL-3B7D3621F7
```

The capture showed the correction marker in subsequent real Work provider
requests. The independent Verifier's provider request contained the original
canonical mission and its original exact-content criterion; its advertised
tool set included `conclude_verification`. Public persisted facts show the
Verifier was a distinct Execution from the producer Work Execution, and that
it successfully used `list`/`read` before concluding. Its ToolObservation
evidence is bound to the exact read invocation/result:

| Criterion | Public result | Evidence |
|---|---|---|
| `file-exists` | Pass | `evd_bb0779f6-5aa4-756c-8b38-8623c3bf6c80`; retained DB binds its ToolObservation to the Verifier Execution's successful exact-file read invocation/result |
| `exact-content` | **Fail** | `evd_768c1f0a-7736-776f-8e67-a43434c8d8f6`; retained DB binds its ToolObservation to the Verifier Execution's successful exact-file read invocation/result |
| `constraints-respected` | Pass | `evd_ae18f3cb-0967-77da-80b4-df58a3814a39` |

The retained produced file is exactly 33 bytes, UTF-8 without BOM and with no
trailing newline:

```text
S2 corrected S2-NORMAL-3B7D3621F7
```

Its SHA-256 is shown above. It does **not** match the still-current
`exact-content` requirement. The public Work read showed the same Work at
revision 1, `Open`, with its original completion expectation; the Verification
concluded `Fail` for target revision 1 with a complete per-criterion snapshot.
No Acceptance was submitted, no Work completion occurred, and Work remained
the current Work. The failure path therefore preserved the P8 quality gate and
left the Work open/repairable.

## Diagnosis

This was not a fabricated artifact, missing verifier context, evidence
misbinding, or model false-negative. The file really violated the canonical
mission the independent Verifier received. The producer followed the
human-authored steer and changed bytes; the verifier correctly compared those
bytes with the still-current original required criterion and concluded Fail.

The contradiction is between owners, not between evidence and verdict:

1. Frozen S2 §8 says that a goal, constraint, or interface adjustment leaves
   the original responsibility unit in place and updates its work.
2. Frozen P6 `04-human-steer` models steer as bounded Inbox guidance and a
   `WorkRevision` increment; its optional `scope` is informational. The current
   `SteerWork` handler does not replace objective, constraints,
   `CompletionExpectation`, or `VerificationMission`.
3. Frozen P8 binds verification to an exact Work revision and a complete
   mission snapshot. The Verifier's mission therefore remained the original
   exact-content requirement even though the normal steer requested a new
   exact-content result. DID v1.58 / F18 further requires the v2 Verification
   row, event and result/receipt to preserve the exact mission, criteria,
   target revision and wake facts; this proposal explicitly keeps those old
   snapshots immutable and does not retrofit them.

Normal Steer advanced the Work revision but did not update the canonical
completion contract. No exact typed human amendment existed in this command
path; guidance text is not an authorized or durable replacement mission.
Weakening the exact-content criterion to make this run pass would erase the
independent oracle and is explicitly not proposed.

## Smallest governance/implementation boundary

Resolve `S2-RDG-01` in owning contracts before implementing a fix. The
accompanying governance draft fixes a typed split between non-normative
Direction guidance and a complete human-authored Work contract replacement.
It fixes the old in-flight Verification behavior to continue on its immutable
old mission/revision, produce only old-revision wake, and remain inapplicable
to current Work Acceptance/CompleteWork. It also specifies CAS/authority/
approval, history retention, exact new mission, receipts/replay, legacy
migration, context injection, API/UI, Normal/Critical parity, and failure/
repair tests. No production code, tests, design document, schema, migration,
or user database was changed by this result. No subsequent real-provider
request was issued **for the Normal case**; a separately authorized immediate-
stop case is tracked independently and is not evidence for this Normal result.
