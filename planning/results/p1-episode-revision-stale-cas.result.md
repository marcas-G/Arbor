# P1 caller EpisodeRevision stale CAS

Status: **PASS for exact stale receipt and replay; broader P1 qualification is
unchanged.**

The caller-provided `expectedEpisodeRevision` is a P1 compare-and-set field.
The authority resolver and sandbox-policy preparation still require the exact
current Execution identity, active status, and episode binding, but no longer
deny or operational-fail solely because the caller's expected revision is
stale. The P1 command transaction compares the expected revision with the
current stored revision and commits `StaleSandboxPolicyInputs`.

Focused regressions prove that a stale expected revision passes resolver
authority selection, then the production SQLite Gateway stores one terminal
stale receipt, creates no decision/event, and exact replay returns the same
receipt. No trusted authority facts or other caller fields were relaxed.

Verification: `pnpm build` PASS; `sandbox-policy-grant-authority.test.ts` and
`sandbox-policy-decision-gateway.atomic.test.ts` PASS, 17/17. Full `pnpm check`
passes lint/typecheck/architecture and core batches 1–5, then stops in batch 6
on five separate schema-48 test fixtures and one AH7 P39 policy-interruption
fixture. Those baseline fixes are assigned on the unified line; no related
baseline production/test semantics were changed in this patch.
