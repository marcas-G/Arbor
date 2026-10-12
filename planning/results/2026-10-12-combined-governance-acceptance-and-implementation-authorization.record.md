# Combined Governance Acceptance and Implementation Authorization Record

Date: 2026-10-12

This record preserves the direct user decision as relayed for this task. The
accepted proposals remain separate semantic packages; this combined record
does not merge their authority boundaries or amend their content.

## Verbatim decision

Accepted decision tokens:

- `ACCEPT_P15_EXTERNAL_PROJECT_COMMAND_ORIGIN_V1`
- `ACCEPT_BLOCKED_WORK_EPISODE_VISIBILITY`
- `ACCEPT_P39_DENIED_UNBOUND_PROJECTION`
- `ACCEPT_P8_VERIFIER_ORPHAN_GOVERNANCE_SURFACE`

User authorization sentence, verbatim:

> 授权上述提案在精确设计落地并复审通过后直接实施和测试；不激活迁移、不升级现有数据库、不发布。

The user authorized implementation and tests only after exact design landing
and a passing consistency review. This record authorizes the design landing
and its review; it does not claim that implementation may begin before that
review passes. It explicitly excludes migration activation, upgrade of any
existing database, and release/publication.

## Fixed packages and B0 review evidence

| Package | Proposal (absolute source path) | Proposal SHA-256 | B0 review (absolute source path) | Review SHA-256 | Accepted token |
|---|---|---|---|---|---|
| P15 external project command origin | `C:\Users\ThinkPad\.codex\worktrees\p15-project-actions\Arbor\planning\proposals\P15-external-project-command-origin-amendment-v1.md` | `E09BDF83099137BC0A694EDA5B0DEBEBAB4C821B5A51C0AB8B94A3F18CC7FECD` | `C:\Users\ThinkPad\.codex\worktrees\p15-project-actions\Arbor\planning\proposals\P15-external-project-command-origin-amendment-v1.review.md` | `1253224F8BBCBC11FA849341B3FC4F0B5888C4B27C1D237E8C1F3F0EED406729` | `ACCEPT_P15_EXTERNAL_PROJECT_COMMAND_ORIGIN_V1` |
| Blocked WorkEpisode recovery visibility | `C:\Users\ThinkPad\.codex\worktrees\s1-blocked-visibility\Arbor\planning\proposals\s1-blocked-work-episode-recovery-visibility-draft.md` | `818F003EC614CFAF552947C355D35D283348D417AD314E8CFC862FBCD35C3ABD` | `C:\Users\ThinkPad\.codex\worktrees\s1-blocked-visibility\Arbor\planning\proposals\s1-blocked-work-episode-recovery-visibility-review.md` | `F8111379E41D40AB844B0F38438647585D9771ED299D5DF74F4E86EA03B60F72` | `ACCEPT_BLOCKED_WORK_EPISODE_VISIBILITY` |
| P39 DeniedUnbound projection | `C:\Arbor-p39-recovery-binding\planning\proposals\P39-unbound-denied-state-design-gap-draft.md` | `294300E103DE1EFC34B250EC41A30DC2EDDBB5671216499254695C32E6D91D1E` | `C:\Arbor-p39-recovery-binding\planning\results\P39-unbound-denied-state-fixed-proposal-review.result.md` | `0959A76AC049048D978472382B7E7A24D264AD5CFD93C397187158341FE69F38` | `ACCEPT_P39_DENIED_UNBOUND_PROJECTION` |
| P8 verifier orphan governance surface | `C:\Users\ThinkPad\.codex\worktrees\s1-verifier-orphan\Arbor\planning\proposals\P8-verifier-orphan-governance-surface-draft.md` | `AC0D158ED86E6ACA6F8E515CC901C022F565CBB97DA24324C914C4D2ECDA1EE3` | `C:\Users\ThinkPad\.codex\worktrees\s1-verifier-orphan\Arbor\planning\proposals\P8-verifier-orphan-governance-surface-draft.review.md` | `1CE590D5D3F50EC20B23DFD05F9A1DBB66E4F774F5942297B46F97B8936E3A2E` | `ACCEPT_P8_VERIFIER_ORPHAN_GOVERNANCE_SURFACE` |

The proposal and review hashes are fixed source evidence, not postimage hashes.
Every landed owner revision, technical rebase, and combined postimage hash is
recorded in the combined landing manifest and review; no isolated proposal
postimage hash is claimed to survive whole-file composition.

## Scope and exclusions

- Land only the four accepted design packages into their owning documents,
  after semantic-preserving technical rebase onto the latest accepted owner
  baseline.
- Update the proposal acceptance records and decision records with the exact
  tokens above, source hashes, owner revisions, and review references.
- Keep accepted owner overlays that are later than the stale local master
  baseline; proposal-only or implementation-only branches are not design
  authority.
- Do not write production implementation or tests in this design landing.
- Do not register, activate, or execute migration 0039, 0041, or 0042; do not
  upgrade an existing database; do not release or publish.

## Landing and review chain

The landing and independent postreview are intentionally separate commits.
Their full commit IDs, tree identities, owner-document before/after SHA-256
values, overlap/rebase proof, final DID/System Design/Scenario versions, and
Blocking result are to be filled by the completed combined landing manifest
and postreview. Until that independent review reports Blocking = 0, the design
landing is not complete and the implementation/testing authorization gate has
not been satisfied.
