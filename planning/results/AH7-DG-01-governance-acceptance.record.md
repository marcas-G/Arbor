# AH7-DG-01 治理接受记录与落地门槛

日期：2026-10-11  
状态：**Proposal ACCEPTED；owner-document landing BLOCKED by unpinned physical schema/migration slot**

## Accepted decision

- Decision: `ACCEPT_TOOL_SETTLEMENT_OBSERVATION_REPLAY`
- Exact accepted proposal SHA-256 (LF bytes):
  `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`
- Proposal commit: `00fe6975341abb35e7d48536295423fe2fa75e1f`
- Independent review verdict reported by the coordinating Governor: **Blocking = 0**.
  The independent review artifact was not present in this isolated worktree, so this record
  preserves the verdict and accepted proposal identity without inventing a review-file hash.
- Acceptance authority: the user's standing manual-governance delegation for an exactly
  accepted fixed package. Acceptance authorizes only the exact owner-contract landing; it
  does not authorize production implementation, migration execution, or AH7 closure.
- Review/acceptance baseline: green commit
  `f80ee9132774c0c1fb570744d81398fad17da188`.

## AH7-DG-03 branch dependency

The accepted AH7-DG-03 proposal source is `ce08b55debcadc8d255bf43f6702ca8da592c129`;
its owner-contract landing is `34ed1c597c02d677d87f4fa9435d8339641ea3d6`; the landing
record is `5cab270642f3a738f1da3dcb846ce734d477f8b2`. The separate implementation branch
head is `codex/ah7-approval-settlement-governance@db929654128b8e864d3733b95088f4edda0e4c43`.
These commits are not ancestors of `f80ee9132774c0c1fb570744d81398fad17da188`; their
merge-base is `6fcbc17e27b694f201792aedd6c2ec368508b542`.

Therefore this acceptance/landing record does not claim those contracts or implementation
are integrated. When the accepted AH7-DG-03 owner landing is later merged, an independent
consistency check must align this package's P4 Denied/Interrupted boundary with the accepted
DG03 contract; this record does not create or repeat a Denied governance item.

## Physical schema / migration blocker

The accepted package requires three additive durable fields on `tool_invocations`:

```text
observation_format_version
observation_json
observation_sha256
```

It states that legacy evidence may be null and new terminal settlement plus Observation
evidence commit atomically. It does **not** pin the exact SQL DDL, including column types,
null/check constraints across intent and terminal rows, or the constraint treatment of
legacy terminal rows. It also does not choose the next global migration slot.

On this baseline, `tool_invocations` is declared in `P4_DDL` and the production migration
sequence reaches id 35. The global P36–P39 slots are conditionally reserved in the current
governance context. Selecting a slot or inferring a DDL/check contract would add a physical
decision absent from the accepted proposal. No migration id or SQL schema was invented.

**No `docs/design/**` owner contract has been changed.** Exact owner-document landing is
paused at this physical contract gap. A fixed DDL and authorized migration-slot decision
must be recorded in an accepted package and independently reviewed before the landing can
continue. This is not implementation authorization.

## Worktree and scope evidence

- Isolated managed worktree base: `f80ee9132774c0c1fb570744d81398fad17da188`.
- Files changed by this turn: this planning acceptance record only.
- No production files, tests, or `docs/design/**` files changed.
- No tests, daemon, migration, or push run.
- Post-landing owner hashes and consistency review do not exist because landing did not occur.
