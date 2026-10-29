# P8 RetryVerification implementation checkpoint

Status: implementation checkpoint reviewed at B0; not a release or phase-
closure claim.

## Scope

Implemented the accepted P8/P10/P12/P13 `RetryVerification` route in the
isolated worktree based on `release@9db9a6cc9b49c4385275944301e5540cfd041be9`.
The external payload is strict and human-only; IDs for the successor
Verification and Verifier Execution are supplied once and remain in the
semantic command payload. The P12 resolver grants this authority only to a
Root-local authenticated human or the exact direct-Parent human for a child
Work; it does not consult PermissionGrants. The handler re-reads Work,
Verification, owner snapshot and every bound verifier Execution, then invokes
the existing P8 conclude/start handlers directly under the one outer Gateway
transaction. It byte-verifies Runtime-stored summary content. The open
successor Verification is the durable spawn intent; the existing
`spawnOpenVerifiers` consumer continues its idempotent admit/bind recovery and
now uses the Verification's frozen owner snapshot rather than retargeting to
the current Work owner.

Receipt recovery is exact and receipt-first: the authenticated external
boundary compares the existing receipt's project, canonical request
fingerprint (which includes command type, actor and payload), handler schema
version, and fingerprint algorithm version before entering the resolver. An
exact RetryVerification match forwards a process-local replay authority to
Gateway, whose durable receipt lookup precedes authority validation and
handler execution. A mismatch returns a stable 409 idempotency-conflict
problem without loading mutable Work/Verification facts or reaching the
handler. An absent receipt follows the normal fresh-command resolver path.

P10 Attention includes an exact Retry descriptor only when the server-side
read-only availability calculation resolves the same authority for the
authenticated principal and canonical facts. Submission resolves authority
again. The Web form submits only through `/commands`; `StartVerification` and
`ConcludeVerification` remain externally rejected. No model-facing action was
added.

## Verification

- Targeted Vitest: core 4 files/50 passed (Retry handler, codec, P12 authority,
  and production registry parity); expanded 7 files/69 passed, including
  external composition exact-replay and actor/type/project/payload mismatch
  cases.
- Child UI/transport qualification: Attention/catalog 15/15, Retry
  availability 2/2, P13 transport 11/11.
- Targeted TypeScript `--noEmit`: `packages/application`, `packages/domain`,
  `adapters/persistence-sqlite`, and `apps/single-workspace` passed. The UI
  contributor separately reports Web and single-workspace typechecks passed.
- Biome passed on the 18 core touched files; the UI contributor reports its
  18-file Web/UI check passed. `git diff --check` passed.
- One `pnpm build` was attempted before the final type-fix checkpoint. It
  failed only on two type-cast diagnostics in the newly added availability
  projection. Those casts were corrected and target typechecks passed, but the
  full build was intentionally not rerun.
- After the receipt-replay fix, the targeted
  `pnpm --filter @arbor/single-workspace build` passed.

No full check, full functional suite, daemon, live database, migration,
release-tree mutation, or publication was performed.

## Review focus / known limits

Independent review of implementation commit
`b15855c7eff71875ff711f8a9d080e2e309399c5` completed at **B0 (Blocking = 0)**.
The first review's same-CommandId replay finding was closed by the exact
receipt-first matcher and focused positive/negative cases. The reviewer
confirmed the direct P8 Start/Conclude handler reuse stays within the one
outer transaction with no inner receipts; unexpected successor-admission
rejection defects to roll back the outer SQLite transaction; and owner
snapshot, existing spawn recovery, and UI availability freshness/TOCTOU had no
Blocking issue. The focused handler test is not a SQLite crash/restart
qualification; this checkpoint does not claim phase closure. Full review
record: `planning/results/P8-retry-verification-review.result.md`.

## Workspace hygiene

The implementation worktree is the isolated managed worktree above. A
six-line command-registry count hunk was accidentally applied to the main
`C:\Arbor` checkout while the correct matching hunk was also applied here.
The main-tree tracked file's pre-edit cleanliness could not be proven, so that
hunk was deliberately left untouched there; a mistakenly-created untracked
copy of the new Retry handler test was removed from the main tree. The main
checkout is not part of this implementation commit.
