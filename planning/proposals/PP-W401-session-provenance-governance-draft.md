# PP-W401 — Session Provenance and Work Context Frontier

Status: DRAFT — requires manual governance acceptance before durable schema or
projection changes.

## Failure evidence

AH10 direct-child AssignWork takeover shows:

- public Placement deterministically returns a `wref_` from
  `(rootWorkspaceId, childWorkspaceId, revision)`;
- a model-authored `targetWorkspaceRef` can be an older `wref_` from shared
  Workspace Session history;
- Work/receipt/action facts otherwise converge across takeover;
- accepting the stale ref would weaken target binding and is unsafe.

## Proposed fact model

Every new typed Session item written by Runtime carries immutable causal
binding: `projectId`, `workspaceId`, optional `workId`, `executionId`, an exact
episode binding, and `causedByRef`. Inbox/UserMessage items retain admission
identity and receive the target Work/episode binding at promotion.

Historical rows without provable binding remain read-only evidence and are
excluded from a Work frontier unless a governed adoption record binds them.

## Projection rules

For a WorkEpisode, Model Context may include only Workspace responsibility and
resource boundary, current Work objective/constraints/completion/verification
mission, current Work's causally bound Session items, and accepted canonical
facts explicitly referenced by the Work frontier.

It excludes RootConversation placement calls/results, other Work episode
observations, and unbound opaque refs. Missing or ambiguous predecessors return
a typed blocked/recovery decision; projection never guesses from the latest
shared Session row.

## Admission and migration

- Work admission records the Work/Execution binding before the first Work turn.
- Existing unbound rows are not assigned by timestamp, current selection, or
  text matching.
- A future governed adoption command may bind an exact historical row set by
  content-addressed evidence; otherwise old rows remain excluded.
- ProviderTurn manifests remain immutable and recovery never recompiles them
  from a new projection.

## Acceptance matrix

1. Root placement followed by direct-child Work excludes placement history.
2. Two Work episodes on one shared Session see only their own frontier.
3. AH10 direct-child takeover converges on the same `wref_`, Work, receipt,
   and Action after restart.
4. Historical unbound rows are excluded or fail closed with a typed diagnostic.
5. Existing Provider manifests resume unchanged after restart.

## Explicit non-goals

No new Attention semantics or Manual-wait semantics are defined here. This
proposal does not authorize design-document or migration changes until manual
governance accepts it.
