# P15 — Project Commands

## RenameProject

Payload: { name: ProjectName; expectedRevision: Revision }. Target is envelope.projectId. The authoritative transaction reads Project and takes the Project lifecycle gate. Only Open plus exact project-governance authority may CAS name/revision. Success appends ProjectRenamed(projectId, previousName, name, revision). Same CommandId uses the ordinary receipt; differing fingerprint rejects.

## CloseProject

Payload: { expectedRevision: Revision; confirmed: true }. Only exact project-governance authority may CAS Open → Closed. The transaction records ProjectClosed and closes the lifecycle gate. Close itself is idempotent only through the same CommandId receipt; a later distinct Close rejects terminal lifecycle mutation.

## Gate

For existing Projects, RenameProject, SubmitHumanMessage, claim, AdmitExecution and every mutation whose precondition is Project Open validate the same gate in their authoritative transaction. CreateProject is absent → Open bootstrap and is excluded. Gate-winning Close blocks later activity but does not erase already committed facts.

## Name v1

Persist policyVersion=1, comparisonKey and displaySkeleton. New/renamed names use pinned Unicode 15.1 NFC and UTS #39 15.1 tables; controls/format/private-use/unassigned reject; whitespace normalizes; result 1…120 scalars. Comparison key and skeleton are server-only.

