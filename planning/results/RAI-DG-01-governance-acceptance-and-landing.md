# RAI-DG-01 Governance Acceptance and Design Landing

**Decision:** Accepted fixed package; design landing committed; independent post-landing review PASS (Blocking = 0).
**Date:** 2026-10-12
**Authority:** The user explicitly authorized Codex to modify existing design
documents when confidence is sufficient. Under that standing authorization,
Codex, acting as the user's delegate, accepted this exact fixed package. This
record does not claim that the user personally reviewed or accepted this
proposal hash.

## Accepted package

- Proposal: `C:\Users\ThinkPad\.codex\worktrees\runtime-safety-readmission-2ea26f0\Arbor\planning\proposals\RAI-DG-01-readmission-hold-governance-draft.md`
- SHA-256: `0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106`
- Pre-acceptance independent review: `readmission_governance_independent_review`,
  Blocking = 0.
- Selected option: A, a durable exact-WorkRevision readmission gate derived from
  canonical settlement/P9 source records and exact Work Episode binding.

The accepted package expressly includes these new semantic decisions:

1. Every Work-bound `Interrupted(RuntimeSafetyStop)` settlement holds that
   exact Work revision, even without a separate P9 fact.
2. An authorized `SteerWork` releases the hold only by advancing the Work
   revision; the old source remains immutable audit evidence.
3. P10 excludes old-revision Attention from the active set using a same-snapshot
   canonical Work revision check, independent of consumer lag or rebuild state.

All remaining closed source, identity, typed-failure, transaction, restart,
projection, and qualification details are accepted exactly as written in the
fixed proposal. This acceptance does not authorize production-code changes or
implementation qualification.

## Baseline and landing

- Landing starts from candidate `4373b37d9ce47af387c781519726a79680cb3920` in
  an isolated governance worktree. The `C:\Arbor` runtime tree is not modified.
- Verified owner baselines at that candidate: System Design v1.13 and DID
  v1.36. The AGENTS.md introductory baseline summary is older than this
  candidate; the actual checked-in file headers govern this landing.
- Design landing commit: `2fb2823515cdd45ac22a9b4119a5cf371ace6ee1`.
- Landed owning revisions (SHA-256 and principal contract locations):

| File | SHA-256 | Changed contract location(s) |
|---|---|---|
| `docs/design/02-system-design.md` (v1.14) | `BC33976CF853B985A2246E39D66DEDF8A6E64E0F8C8175475E29C55BAFBF8D34` | hold §3.4 line 526; scheduler §7.6 lines 1180–1182; Attention §12.3 line 1692; invariant 77 line 1954 |
| `docs/design/03-detailed-implementation-design.md` (v1.37) | `08DCB80A7CF0E946A41EE48966F4314C5C734AB6322D8B49CF58DF07FC974F99` | governance entry line 138; §8.18A.1 line 4548; qualification §8.18A.2 line 4589 |
| `docs/design/implementation/P10/00-contract-index.md` | `27E21E30987BBB4C680A2F765E2F73FAA9FE920C129CF5E5E647F96B2E0351AA` | RAI-DG-01 owner index line 3 |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `64294E8A8A000587B20FB8A75D16A53FD2067112AF012F49FA9B89107E504D80` | §1.1 line 19; closed `ProjectionIntegrityFailure` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `33A4B2532F19A499995DFB18452E8D373C5DBD70C34789C447BECCD676E0FC52` | RAI-DG-01 rebuild rule line 11 |
| `docs/design/implementation/P10/07-acceptance.md` | `5452229B53DDAF9134433DF74793E8D57049E1F3EE8B5045AAC69A14C54A6482` | Story M line 20 |
| `docs/design/implementation/P2/00-contract-index.md` | `24932C9628B08450112AB5AD135877C2685AFE89CFD6CD0114B4E0EDD92F19E7` | RAI-DG-01 owner index line 3 |
| `docs/design/implementation/P2/01-command-contracts.md` | `ADF168E543A4BCA2CB5B494E4B0AB8389DE00CCD041E43D99BEA291FC0274DE6` | EGP alignment line 236; admission overlay line 269 |
| `docs/design/implementation/P2/02-port-contracts.md` | `8A6DA2491CD83ACD8F70817824286B4F3E7A78425C631E1A95901DEDA1A469A6` | §7.1 line 359; typed stores/failures and exact identity checks |
| `docs/design/implementation/P2/04-sqlite-schema.md` | `175D38712E15B85C0375156B240A8B8AD0CB4B8D76305C665B82B16378940F1F` | final EGP schema note line 112 |
| `docs/design/implementation/P2/05-scheduler-wait.md` | `40034EACE4E9F7FEB545FFF08C7A0A4A5834DC552F3AC9B6DDBF2894D85236A8` | EGP overlay line 74; gate decision overlay line 97 |
| `docs/design/implementation/P4/00-contract-index.md` | `5856B37A1C3C36D3C3661F36DEF32B2353ED8F22FED0E0DDA30753B845511072` | RAI-DG-01 owner index line 3 |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `CA8B9BC164CCED6EB6B7C3ABF5A18CF6575123C7F40BCB05312940D07D45BEE2` | OutcomeUnknown source clarification line 154 |
| `docs/design/implementation/P7/00-contract-index.md` | `6479CC2DE173C7DD0D9D3251CA1DFE4E25505D536E465ABB3EA538B17470F32B` | RAI-DG-01 owner index line 3 |
| `docs/design/implementation/P7/03-runnability-classification.md` | `15DAD3F530C3ED8AFFBBF849EFB7FD23E92C070CD5263AD2F214576BDE2AB14A` | held predicate line 38; read set line 61; typed errors line 66 |
| `docs/design/implementation/P9/00-contract-index.md` | `FFC10549C74ACDB098F7E78EF806798E40318A4C47D9A2F5B13249C99DA9AF75` | RAI-DG-01 owner index line 3 |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `01D76830AA39F8935A0AF031E94DC46F11E806FF722079CDAD6E5D27750F68DF` | closed source/code inventory §2 line 120 |

## Landing checks

- `git diff --check` and `git diff --cached --check`: PASS.
- `pnpm lint`: exit 0; one pre-existing warning remains in untouched
  `packages/agent-runtime/src/model-decision.ts:4070` (`noNonNullAssertion`).
- Proposal hash rechecked after landing and matches the accepted SHA above.
  Grep/count audit found all eight Deliver replay codes and all fourteen
  AssignWork binding codes in P9 `07`.
- Exactly the 17 owner files listed above changed in the landing commit; no
  production code or migration changed. No implementation tests were run or
  implementation authorization inferred.
- Independent post-landing review is complete: **PASS; Blocking = 0**. The
  reviewer verified proposal v2 against design landing `2fb2823` and audit
  commit `ba8a4a7`, including all 17/17 owner-file hashes, versions, closed
  source/code sets, typed gate errors, P10 revision filtering and EGP binding.
  The reviewer conclusion was delivered in the root task session. The
  independent proposal-v2 review body is recorded at commit `90f4d9d`
  (`planning/proposals/RAI-DG-01-readmission-hold-governance-draft.review-v2.md`);
  that file is the proposal review, not a separately saved post-landing report.
  No separate post-landing review file was supplied with the reviewer result.
- The post-landing review confirms the design landing is internally
  consistent. It does not authorize implementation or qualify runtime behavior.
