# Test Implementation Plan

**Audit date:** 2026-09-27  
**Constraint:** Stop after the first qualification run. This plan records the
remaining test work; it does not authorize deferred product/design work.

## First qualification run disposition

The first full regression run in the pinned environment is recorded in
`08-known-failures.md`. No complete B01–B14 black-box case ran: live provider
configuration was absent, and S01/ControlToolRegistry qualification is
explicitly unauthorized. Therefore the capability qualification result is
`0/14 CAPABILITY_PROVEN`, with required live cases `NOT_RUN` or blocked as
shown in the cards.

## Ordered test work

1. **Retain this baseline and failure evidence.** Keep the original failed
   assertion and unresolved second suite status. Do not alter the failing
   assertion to restore a green report.
2. **Build the inventory with per-test metadata.** Add L1/L2/L3,
   `provider_mode`, persistence, ToolRuntime, daemon-path, assertion scope, and
   overclaim fields to each existing test record. Prefer test annotations plus
   a generated inventory. Reject unclassified tests in the inventory check;
   do not mass-classify solely from directory names.
3. **Run B04 first when an explicit provider configuration is available.**
   Use the BLUE-WHALE-17 same-session recall and unrelated-session negative
   oracle. Save all three request/response pairs and outcomes. The second-turn
   input must not contain the first-turn text.
4. **Complete B01 as an external scenario.** Submit through the production
   user/API path, run a real model, read the formal Assistant response through
   Web/API transcript, and assert exactly-once behavior under retry.
5. **Complete the P14/B14 semantic browser/API case.** Join real submission,
   response, transcript visibility, ModelOutput exclusion, and older-page
   merge in one external scenario.
6. **Close L2 matrix gaps without changing product behavior.** Prioritize the
   BlobStore body-to-Message round-trip and recovery-to-next-context diagnostic
   evidence if the implementation exposes them. Tests may fail and become
   findings.
7. **Qualify B05–B13 only when their model-facing route is authorized and
   available.** Preserve component and integration evidence meanwhile.
8. **Resume B10 only after manual governance closes its applicable existing
   verification reference gaps.** Do not add fixtures that invent a source or
   persistence semantic.
9. **Do not run B02/S01 or implement/qualify ControlToolRegistry/B03 without
   an explicit authorization update.** The architecture adoption itself is
   not that authorization.

## Test-review exit conditions

- Every test has a reviewed evidence tier and provider mode.
- Every black-box case has the uniform card fields and an evidence location.
- Only a complete L3 PASS can mark a capability `CAPABILITY_PROVEN`.
- Real-provider cases include the declared environment and preserved
  request/response evidence.
- Known failures remain in qualification output and are not converted into
  skip/pass.
- No product, Prompt, or frozen contract change is included in test-only work.
