# F18 Verification v2 consumer/read-model RED evidence

Date: 2026-10-21  
Code baseline: `fcc2e64287ef2be73301631e0d4322cd3c9e8c9b`  
Disposition: **RED confirmed; production design conflict, no code fix applied**

## Invocation

Fresh detached worktree:

```text
C:\Users\ThinkPad\.codex\worktrees\f18-verification-unknown\Arbor
```

Commands:

```powershell
pnpm install --offline --frozen-lockfile
pnpm build
pnpm --filter @arbor/web build
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/organization.functional.test.ts --reporter=verbose
```

The final diagnostic run executed the production daemon, public HTTP API,
scripted HTTP provider, fresh schema-50 clone and real filesystem tool path.
It failed the one F18 case at the public wait boundary after 19.879 seconds;
daemon stderr was empty. The ordinary unmodified test reproduces the same
failure at its 30-second public bound.

## Disposable database evidence

The failing fixture database/WAL/SHM triplet was copied before teardown solely
for read-only diagnosis:

```text
C:\Users\ThinkPad\AppData\Local\Temp\arbor-f18-debug-20261021\f18-debug.db
C:\Users\ThinkPad\AppData\Local\Temp\arbor-f18-debug-20261021\f18-debug.db-wal
C:\Users\ThinkPad\AppData\Local\Temp\arbor-f18-debug-20261021\f18-debug.db-shm
```

| File | Bytes | SHA-256 |
|---|---:|---|
| `f18-debug.db` | 1,257,472 | `94EFD1B4B2A2A99138FB18C0D1A218F72F549BA1505800B9E0CF75703A27E8FB` |
| `f18-debug.db-wal` | 2,785,152 | `AEC3BB2BFFCA0BE185C2C2A7E1C53B69EF013BF839C8964DF941D01CB23BFEDE` |
| `f18-debug.db-shm` | 32,768 | `4A808F3148FEB848C81668797CBFC99F4AB9BB77AB79BADD5E0575CD11FF1B9B` |

`PRAGMA integrity_check` returned `ok`. The copy is disposable evidence and is
not a preserved/user database or an upgrade target.

## Proven producer and Verifier path

- Project: `prj_8ab33c14-77f0-7c40-8832-75a41777aebb`
- Root Workspace: `ws_d0e9ca32-21f6-71e5-83c6-55af0cb64d3a`
- Child Workspace: `ws_5cd5ec40-01a1-7a49-8880-69c750872272`
- Child Work: `wrk_5cd5ec40-01a1-7a49-8880-69c750872272`, revision `0`
- Verification: `ver_ba3424ad-1417-7f8c-8f5d-9669b994314c`
- Verifier Execution: `exe_db7b5e6e-7b1a-794a-8f93-1d112f41a653`
- ToolInvocation: `tin_018f2b3c-4d5e-7abc-8def-6798cbd182bb`
- Evidence: `evd_4b4ebdaa-a81f-78d2-86d2-01f4663e79ae`

The child and Root boundaries both resolve the fixture `workspace` FileTree.
The Verifier's canonical `read` invocation has settlement `Success`; its
ToolResult is:

```json
{"text":"FUNCTIONAL_VERIFIED","truncated":false,"byteSize":19}
```

The exact ToolObservation Evidence is bound to that invocation, observation,
Verifier Execution and callRef. The Verification row is:

```json
{
  "state": "Concluded",
  "verdict": "Pass",
  "snapshotStatus": "Available",
  "criteriaResults": [
    {
      "criterionId": "functional-criterion",
      "requirement": "proof.txt contains FUNCTIONAL_VERIFIED for F18-CHILD-54f62faf",
      "required": true,
      "verdict": "Pass",
      "evidenceRefs": ["evd_4b4ebdaa-a81f-78d2-86d2-01f4663e79ae"]
    }
  ]
}
```

This proves the FileTree, proof path, Verifier mission, evidence reader and
criterion snapshot are not the failing layer.

## Event and reliable receipt

Journal sequence `17` is:

```text
eventId              5904c98f-ba96-4ca9-9cfe-1a9eb5e5fb05
eventType            VerificationConcluded
eventVersion         2
aggregateRef         ver_ba3424ad-1417-7f8c-8f5d-9669b994314c
causedByCommandId    cmd_91dabea7-08f1-7bc5-8d68-657d8644102a
```

Its payload contains the same Work/revision, `Pass`, complete mission,
criterion `Pass`, Evidence ID, summary ref and `Available` status as the
canonical row.

The causative command row is `Committed`, schema version `2`, in the same
Project. Its result carries the exact same conclusion snapshot plus:

```json
{
  "wakeSignals": [],
  "channel1Release": {
    "workId": "wrk_5cd5ec40-01a1-7a49-8880-69c750872272",
    "targetWorkRevision": 0
  }
}
```

No retry of the command, Verifier or Provider is necessary or safe.

## Dead letters and offsets

The captured database contains six dead letters for sequence `17`, each with
the exact stored reason `unsupported eventVersion 2`:

```text
completion
dependency-coordinator
formation
p10-rebuild:attention
verification
workflow-signals
```

Every corresponding `consumer_offsets.last_sequence` is already `18`. Thus a
reader fix alone cannot redeliver sequence `17`; the missing workflow effect
requires explicit historical reconciliation. Resetting offsets was not
attempted.

The production composition currently also mounts the independent raw-journal
`runAttentionPollOnce` reader under the same `p10-rebuild:attention` consumer
identity. Its source code has a separate `eventVersionRaw > 1` check whose
reason text is `unsupported eventVersion`. In this captured run, the ordinary
dynamic P10 consumer advanced the shared offset first, so the stored P10 row
uses the ordinary reason with the numeric suffix and the raw reader did not
see sequence `17`. This does **not** prove the raw reader is compatible with
v2; the governance package therefore requires that reader to use the same
exact type/version table as every other path.

## Missing Parent Inbox and stale read model

The Root Inbox contains only:

```text
humanmsg:msg_185a478d-afd1-71fb-8f57-456dda845b87
gov:fpr_5cd5ec40-01a1-7a49-8880-69c750872272:1       (consumed)
dec:fpr_5cd5ec40-01a1-7a49-8880-69c750872272:1:Approve
```

It has no expected row:

```text
child-result:ver_ba3424ad-1417-7f8c-8f5d-9669b994314c:0
```

The public Verification view simultaneously returned:

```json
{
  "verificationId": "ver_ba3424ad-1417-7f8c-8f5d-9669b994314c",
  "targetWorkRevision": 0,
  "verdict": "Pass",
  "criteriaResults": [
    {
      "criterionId": "functional-criterion",
      "required": true,
      "verdict": "Unknown"
    }
  ],
  "evidenceRefs": ["evd_4b4ebdaa-a81f-78d2-86d2-01f4663e79ae"]
}
```

The `Unknown` is produced by the stale hard-coded projection in
`packages/projection-runtime/src/views/verification.ts`; it is not canonical
Verification state.

## Conclusion

F18 exposes one cross-layer convergence gap:

```text
accepted VerificationConcluded v2 writer
→ obsolete global reader ceiling=1
→ valid event quarantined and offset advanced
→ Parent result delivery omitted
```

The public read model independently still implements the pre-P46 assumption
that criterion snapshots do not exist. The fixed governance proposal is
`planning/proposals/F18-verification-v2-consumer-and-readmodel-convergence-draft.md`.
No production code, frozen design document, migration or preserved database
was modified during this diagnosis.
