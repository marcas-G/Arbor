# BLACKBOX-GAP-01 — Real-provider CompletionClaim instability

**Status:** OPEN — release-validation blocker for unattended Work completion

**Discovered:** 2026-10-02 S1–S4 black-box qualification

**Owner:** Work Agent cognition / provider tool-call delivery / completion-claim control route

## Failure evidence

The deterministic public-process black-box completes the full path:

```text
AssignWork → arbor_claim_completion → Verification → Parent Acceptance
→ CompleteWork
```

The real DeepSeek B11 sentinel remains unstable. In the latest three-run batch:

```text
PASS: 1
FAIL: 2
```

The passing run settled `Completed(CompletionClaimed)`. Failed runs ended before
a durable claim; captured provider traces include output repair/protocol failure
rather than a false completion. Runtime therefore fails closed, but autonomous
progress is not reliable enough for release qualification.

Evidence report:

```text
C:/Arbor/planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-22-45.176Z-6c4f46e7-d677-42d2-b28e-f51902ac3042.json
```

## Safety disposition

- No Work was falsely completed.
- No Verification or Acceptance boundary was bypassed.
- The failure is availability/progress reliability, not canonical-state
  corruption.

## Required follow-up

1. Preserve the exact failing provider wire trace and replace `[object Object]`
   capture with typed/safe failure taxonomy.
2. Distinguish model non-compliance, incomplete tool-call wire output and
   Session frontier reconstruction.
3. Decide whether the completion-oriented TurnProfile needs a stronger
   versioned instruction or an explicit provider tool-choice policy.
4. Re-run B11 three times; closure requires 3/3 PASS with no false completion.

This gap does not reopen Verification/Acceptance semantics.
