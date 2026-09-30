# P15 — Project Commands

## RenameProject

Payload: { name: string; expectedRevision: Revision }. Target is envelope.projectId. CommandGateway requires Project Open; exact project-governance authority and repository CAS still apply. Success writes the normalized name, increments Project.revision only, and appends ProjectRenamed(previousName, name, revision).

## CloseProject

Payload: { expectedRevision: Revision; confirmed: true }. CommandGateway requires Project Open. The handler CASes Open → Closed, requests cooperative stop for every unsettled project execution, and performs the conversation terminalization described in `03`. Same CommandId replays its receipt; a distinct later Close rejects because Closed is terminal.

## Gateway admission

The default for every unknown/new command is OpenRequired. The only current exceptions are:

- Bootstrap: CreateProject.
- ClosedAllowed: StopExecution, SettleExecution, RevokePermission, RetireWorktree.

This central default replaces the earlier rule that every handler independently remembers to check Project.lifecycle.

## ProjectName v1

The server normalizes NFC, folds Unicode whitespace to ASCII spaces, trims, rejects Cc/Cf/Cs characters, and requires 1..120 Unicode scalars. CreateProject and RenameProject use the same function. No comparison-key, skeleton, uniqueness or Unicode-table persistence is claimed in local v1.

