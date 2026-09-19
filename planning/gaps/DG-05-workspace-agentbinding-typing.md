# DG-05 — `Workspace.agentBinding` typing vs `AgentBinding` union

## Status

RESOLVED — System Design v1.3 / DID v1.4.

## Resolution

`AgentBinding` is now umbrella vocabulary over
`ResponsibilityBoundAgentBinding` / `ExecutionBoundAgentBinding`.
`Workspace.agentBinding` is typed `ResponsibilityBoundAgentBinding`;
execution-bound bindings are Execution-scoped only and must not be stored in
a Workspace. Execution-side record renamed `ExecutionBoundAgentBinding`.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 §1.1, §1.6, §3.2, §3.4, §9.4, §14.5
- `docs/design/02-system-design.md` v1.3 §2.2

Resolved in: System Design v1.3 / DID v1.4.

## Owning design document

`docs/design/03-detailed-implementation-design.md` (§1.6, §3.2).

## Symptom

`AgentBinding` has two classes — `ResponsibilityBound` (→ Workspace) and
`ExecutionBound` (→ Execution) — but the `Workspace` field `agentBinding`
is not constrained to the Workspace-appropriate variant.

- §1.6:555-565 defines the two binding classes and their owners.
- §3.2:751 lists `AgentBinding` as a `Workspace` field.
- §3.4:806-810 defines `ExecutionBoundAgent` for Execution.

## Evidence

The frozen field list types `Workspace.agentBinding` as `AgentBinding` with
no narrowing, so a Workspace could legally hold an `ExecutionBound` binding,
contradicting §1.6. Conversely it is unstated whether the Workspace field is
exactly `ResponsibilityBound`.

## Why planning cannot decide this

Constraining the field to `ResponsibilityBound` is a **domain type
semantic**. It is very likely the intent, but the frozen text does not state
it, so planning must not silently narrow it.

## Required resolution

Manual governance must state whether `Workspace.agentBinding` is exactly
`ResponsibilityBound` (and define the corresponding Execution-side type).

## Affected planning tasks

- `P0-006` (Workspace field typing)
- `P0-015` (`AgentBinding` ADT)
