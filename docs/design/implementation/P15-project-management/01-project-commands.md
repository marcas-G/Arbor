# P15 — Project Commands

## RenameProject

Payload: { name: string; expectedRevision: Revision }. Target is envelope.projectId. CommandGateway requires Project Open; exact project-governance authority and repository CAS still apply. Success writes the normalized name, increments Project.revision only, and appends ProjectRenamed(previousName, name, revision).

## CloseProject

Payload: { expectedRevision: Revision; confirmed: true }. CommandGateway requires Project Open. The handler CASes Open → Closed, requests cooperative stop for every unsettled project execution, and performs the conversation terminalization described in `03`. Same CommandId replays its receipt; a distinct later Close rejects because Closed is terminal.

FT-DG-03: `RenameProject` and `CloseProject` use strict registered descriptors
derived from these exact closed payloads. Codec validation does not alter P15
project lifecycle admission or exact project-governance authority (DID §4.1B).
P13 `02` §2 owns the UI/external-origin classification. It exposes these two
commands only to a local human recognized by the existing P12 authenticated
human facts through `/commands`; the authenticated principal must exactly
match envelope.actor, and the Authority Resolver must issue the existing
exact `ProjectGovernanceAuthority` for the command type and envelope.projectId.
No Agent-originated path is enabled. The P15 payloads contain no workspaceId
or executionId; P12's exact subject/capability/target grant matching remains
unchanged. HumanPrincipal grants are user-principal-bound, while WorkspaceAgent
and Execution grants require matching canonical workspace/execution facts that
these commands do not supply. A static Agent credential or project-targeted
Agent grant therefore cannot become project-governance authority. If
authentication or authority is missing or uncertain, the request fails closed
before Gateway mutation. CommandGateway still enforces Project OpenRequired;
each handler keeps its existing expectedRevision CAS. No new grant, authority,
or command route is introduced.

## External route acceptance evidence

Qualification uses the real external `/commands` composition and must show:

- An authenticated local human with exact actor/principal binding can rename
  and archive an Open target through the existing commands.
- An Agent/non-human principal without an existing applicable authority, an
  actor/principal mismatch, and an unresolved target cannot mutate a Project
  row or append a Project event; a missing target produces no cross-target
  mutation.
- An Agent principal authenticated by a static token remains denied even when
  the target Project has an active P12 RenameProject/CloseProject grant scoped
  to that Agent's WorkspaceAgent identity and exact ProjectId. The command has
  no matching workspace/execution fact; assert no Project/Event mutation and
  no Gateway receipt for the resolver denial.
- After Close commits, a distinct Rename remains rejected by existing
  OpenRequired admission, with no name/revision change or ProjectRenamed event.
- Existing receipt replay, revision CAS, and exact projectId targeting remain
  in force; no Agent permission or per-user project ACL is added.

## Gateway admission

The default for every unknown/new command is OpenRequired. The only current exceptions are:

- Bootstrap: CreateProject.
- ClosedAllowed: StopExecution, SettleExecution, RevokePermission, RetireWorktree.

This central default replaces the earlier rule that every handler independently remembers to check Project.lifecycle.

## ProjectName v1

The server normalizes NFC, folds Unicode whitespace to ASCII spaces, trims, rejects Cc/Cf/Cs characters, and requires 1..120 Unicode scalars. CreateProject and RenameProject use the same function. No comparison-key, skeleton, uniqueness or Unicode-table persistence is claimed in local v1.

