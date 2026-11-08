# Governance Gates

These questions change durable semantics and therefore cannot be resolved by
implementation preference.

## G-01 — Session provenance

Decide whether shared Workspace Session remains the storage boundary. If yes,
define the immutable provenance fields for Inbox input, Work episode output,
RootConversation output, observations, compaction, and accepted facts. If no,
define the lifecycle and migration of a Work-specific frontier/session.

Required decision outputs:

- ownership tuple;
- causal predecessor rule;
- projection inclusion/exclusion rule;
- migration/replay behavior;
- public inspection behavior.

Observed implementation evidence now includes AH10 direct-child takeover:
the public placement projection deterministically derives the current `wref_`,
but the Work model turn can author a stale historical `wref_` from the shared
Session. This confirms that G-01 is not theoretical; Runtime must not accept a
stale opaque ref as a compatibility fallback.

Decision-ready draft: `planning/proposals/PP-W401-session-provenance-governance-draft.md`.

## G-02 — Work admission handoff

Define the durable fact created by AssignWork and the exact scheduler successor
that admits the Work. Specify duplicate delivery, RootConversation failure,
daemon restart, fencing loss, and stale selection behavior.

Decision-ready draft: `planning/proposals/PP-W402-work-admission-handoff-governance-draft.md`.

## G-03 — Blocked Work disposition

Define when terminal action rejection followed by Manual wait becomes a public
Attention or Work Detail outcome, what resume command is legal, and how the
fact clears. Plan content remains non-authoritative unless explicitly accepted.

Decision-ready draft: `planning/proposals/PP-W405-blocked-work-disposition-governance-draft.md`.

## G-04 — Runtime error taxonomy

Confirm the public distinction between provider unavailable, context
unsatisfiable, binding mismatch, reconciliation required, governance blocked,
and safety stop. Each must have a stable recovery action or an explicit
terminal disposition.

## Gate rule

Until a gate is accepted, implementation may only add read-only evidence,
isolated reproductions, or tests proving the current gap. It must not add new
durable fields, reinterpret existing statuses, or silently promote a Manual
wait into Attention.
