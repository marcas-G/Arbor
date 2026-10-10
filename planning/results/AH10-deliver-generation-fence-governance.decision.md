# AH10 Deliver Generation Fence and Replay — Governance Decision

Date: 2026-10-10

Decision: **ACCEPTED under the user's standing delegated governance authority**

Acceptance marker: `ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

Accepted proposal: `planning/proposals/AH10-deliver-generation-fence-governance-draft.md`

Accepted proposal SHA-256: `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`

## Authority and review

The user has standing authority for Codex to make accepted design changes and implement them without seeking per-change approval when there is sufficient confidence. This record exercises that delegated authority for the exact fixed proposal above; it does not accept or authorize semantics beyond that hash.

The independent review of that exact proposal concluded **Blocking = 0**. The proposal's recommendation is accepted: map the Deliver AgentAction through the DeliverMessage/1 CommandGateway route, preserve Message handover semantics, apply P1 receipt-first takeover, and use the specified P9/P10 legacy-evidence failure path. The deliverable/event/inbox/receipt proof fields and route order are exactly those in the accepted proposal.

## Implementation boundary

This is design acceptance and authorizes the exact owner-document landing package. It does **not** authorize production or test implementation. Implementation remains subject to the separate, ordered qualification gates in the accepted proposal, including strict route/receipt unit qualification, P9/P10 fact and projection qualification, and the real two-daemon kill/restart matrix. No AH10 closure claim follows from this decision record.

## Required landing audit

Land only the owning-contract changes fixed by the accepted proposal, with a post-landing consistency review against the accepted SHA-256. Any mismatch, missing owner, or required semantic beyond the package is a new design gap and must stop this landing before implementation.

