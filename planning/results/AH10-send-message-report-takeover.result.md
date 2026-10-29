# AH10 SendMessage Report and committed-receipt process qualification

Date: 2026-10-17
Baseline: `eca90804a7bbebced2cb84c2886340e76b522223`
Status: **PASS for the five added cases and the complete SendMessage process file; AH10 remains PARTIAL.**

## Added real-process cases

`tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts`
now covers the remaining kind/state cells:

| Kind | R− / R+ (`FencingRejected` before / after commit) | C/P (Committed receipt, Action/Observation pending) |
|---|---:|---:|
| Query | Existing | Added |
| DecisionRequest | Existing | Added |
| Reply | Existing | Existing |
| Report | Added | Added |

Each new case uses the production fixture, public Project/child-Workspace/Work
setup, two independent daemon processes, P2-acquired leases, the persisted
ProviderTurn and exact ActionIntent identities. Query assertions retain its
model-selected parent recipient and open correlation. DecisionRequest asserts
the direct-parent Message, the same ProviderTurn's Wait action, workflow offset
advancement, one Parent InboxEpisode and child Work settlement. Report asserts
child-to-direct-parent routing, null correlation and the frozen no-promotion
result. All kinds assert one Message, one MessageSent event, one Inbox row and
one Action Observation; the Committed case reuses the gen0 receipt without a
new Command or repeated Provider decision.

The same-run failures in the first whole-file attempt exposed old fixture gate
ordering, not a product defect. Reply and DecisionRequest R−/R+ observed
`pauseRequested=false` because gen0's renewal was not explicitly parked. Their
fixtures now use the delayed-renewal gate and a marker, verify the old live
lease, wait for its real expiry and require gen1 acquisition before releasing
the old ActionIntent. The DecisionRequest C/P case also releases the existing
new-owner ActionResult gate before waiting for the workflow-signal consumer;
before release, the offset behind `MessageSent` is the intended paused state.
Receipt commit boundaries and timeouts were retained.

## Verification

- Root `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (existing chunk-size warning).
- New cases individually: Query C/P 1/1; DecisionRequest C/P 1/1; Report
  R−/R+/C/P 3/3.
- Reply R−/R+ after gate repair — 2/2 PASS.
- Full SendMessage process file, serial, retry disabled — 12/12 PASS.
- `pnpm typecheck` — PASS.
- Biome check on the modified test — PASS.
- `git diff --check` — PASS.

This qualifies only these SendMessage process cells. It does not close AH10 or
qualify other action kinds and takeover states.
