# FT-DG-01 v3 functional-scope design landing

Date: 2026-10-10

Isolated worktree: C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor

Landing base after importing the v3 proposal and hash-binding correction:
 a8d41c45f74366ea45d1daaca27e5f95980162fb

Authority: the user standing authorization relayed for this task permits
evidence-backed design updates without a separate per-edit permission request.
This landing applies only the FT-DG-01 v3 functional-scope candidate and does
not convert its three OPEN items into closed semantics.

Applied proposal content SHA-256:
274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0

## Owner landing and digests

The SHA-256 values below are computed over the staged Git blob contents (LF
normalized). The previous hash-binding note separately records the CRLF
working-tree hash and the Git object ID.

| Owner document | Revision / landing | SHA-256 after landing |
|---|---|---|
| docs/design/02-system-design.md | v1.12 → v1.13; §4.5.1 host Profile trust and durable boundary semantics | C2C9BBDCB072A58284472658ABB4D66E70268F95093D658158F87CBF635599C6 |
| docs/design/03-detailed-implementation-design.md | v1.34 → v1.35; §4.1C CreateProject v2 order, failure, persistence and compatibility contract | 003480B5EF1EB6AD7EDB51A35A4C43872800937A742E960F3F84ABA00AA28E0D |
| docs/design/implementation/P1/01-command-contracts.md | CreateProject v2 payload/schema and ProjectResourceUnavailable; ProjectCreated v1 unchanged | 60133CC43F0C98E9BF94A41F92F5907363B4A240DD98748528788F28687152BD |
| docs/design/implementation/P1/02-port-contracts.md | immutable ProjectResourceProfilePort and transaction/I/O boundary | E492490F5F96486D68849E91CCCCE763595123E85F106E555E4CCE62636C567A |
| docs/design/implementation/P12/00-contract-index.md | TR-12 cross-phase host catalog/transport entry | 0BBE343457A9F6F5E9E5231CBAFB20364EAE79CF812D236347C3EDEA5753D9B8 |
| docs/design/implementation/P12/10-transport-shells.md | authenticated, path-free GET /project-resources and host Profile configuration | AAADC65B7A359F3875B4B017F2B4F66D5D287D9FB42AD260D2CBC910D093CF38 |
| docs/design/implementation/P13/02-command-exposure-matrix.md | CreateProject remains human/bootstrap; form selects Profile or ConversationOnly; §3 specifies one-available auto-selection and explicit ConversationOnly when none are available | C0544A12A7E55B209A2F427E4DD0E99EDE43455CB2FB81FD47BF84D9491EB688 |
| docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md | bootstrap boundary precondition; MAC Work/Verification/Acceptance semantics unchanged | BDCD4BEA0F0AECA967393A0BA350C908EB3FCF7EE1CAD60AC0424D7588E7C607 |

## Consistency and scope boundary

- External ordering remains authentication → strict server-selected wire-v1
  decode → ID validation → current Handler schema/fingerprint → exact
  Actor/Principal binding → Resolver visibility → Gateway BEGIN IMMEDIATE
  tuple/receipt comparison. No receipt pre-read was introduced.
- CreateProject Handler semantic schema v2 is distinct from external wire
  codec v1. Profile ref/version is part of the request fingerprint; paths are
  never caller input. Profile lookup is a pure in-memory P1 Port lookup only
  after the Gateway finds no receipt.
- Project, root Workspace, Primary Session, and existing ProjectCreated /
  WorkspaceCreated EventVersion 1 events stay in the same command transaction.
  The canonical Workspace ResourceBoundary is durable. Ownership activation
  reads it back after commit; it cannot take a new path from payload or registry.
- Existing CreateProject v1 payloads/receipts remain preserve-only. No
  historical decoder, old-schema comparison, row rewrite, or migration was
  added. F23 tuple mismatch and non-disclosure remain unchanged.
- No ProjectCreated EventVersion 2, P1 05 policy change, SQL schema change,
  migration, production code, test, F21 movement, or GitWorktree lifecycle
  change is part of this landing. P6 Child Workspace ceiling semantics are
  unchanged.
- P12's Authority Resolver remains pure. The host catalog is transported
  separately and lists no canonical path.
- The existing profile source audit, old-v1 same-ID success compatibility,
  and post-commit durable Attention questions remain OPEN; this landing does
  not claim full FT-DG-01 closure or F21 qualification.

Only the documents in the table and this landing result are intended for the
landing commit. No tests were run. The full functional suite on C:\Arbor was
not accessed, stopped, or modified.

## Follow-up review correction

The independent review found that P13 §3 did not spell out two UI behaviors
already required by v3 §3. The follow-up adds those exact rules: preselect the
sole available Profile, and when none are available, explain ConversationOnly
limitations and require an explicit user selection rather than silently
creating an empty boundary. Unavailable Profiles are never auto-selected or
silently converted to ConversationOnly. This is a P13 presentation-policy
clarification only; it does not change command, authority, receipt, or resource
semantics and does not close any OPEN item.
