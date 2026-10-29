# 2026-10-12 Combined Governance Landing Manifest

Status: owner landing frozen for independent postreview; no implementation,
test, build, migration activation, database upgrade, or publication performed.

## Authoritative base and version chain

- Worktree: `C:\Users\ThinkPad\.codex\worktrees\accepted-gov-v143-converge\Arbor`
- Branch: `codex/accepted-governance-combined-v144`
- Combined base: `ca07ee9a6ad5d3570056bbdec5fe490c25878764`
- Subject: `docs(planning): add AH14 P42 storage options`
- Parent: `46c1b098bfa92be388558579ea46a694ccc69937`
- Base DID v1.43 Git blob: `7dbf9770bebf319d11988095367765013a7b486b`
- Base System Design v1.16 Git blob: `437edb0daeb67da4c313bd85226a7bc07bf889d5`
- Base Scenarios v1.3 Git blob: `bac30f177f4cfd102f346bcbb0a65e79980fccc1`
- The selected base is the latest accepted-owner partial-order frontier. Local
  `master@1e7ab0c260f1834f58ce026b484827b245ba852d` and dirty root
  `codex/functional-tests@f80ee9132774c0c1fb570744d81398fad17da188` are
  stale/non-authoritative for this landing; that divergence is a repository
  integration gap, not permission to regress accepted design.
- Final owner version chain: Problem & Goals stays v1.3 (frozen); Scenarios
  v1.3→v1.4; System Design v1.16→v1.17; DID v1.43→v1.44. DID v1.44
  references System Design v1.17. P2 new-write EGP cleanup keeps
  `ExecutionEpisodeBinding = Work | ConversationResponse | Inbox | Decision`;
  old focus/Coordination values remain migration/decoder evidence only.

## Accepted-owner convergence ledger

At the pre-landing tree `ca07ee9a6ad5d3570056bbdec5fe490c25878764`, the
upstream non-ancestor query `git log --all --format='%H %s' ca07ee9a6ad5d3570056bbdec5fe490c25878764.. -- docs/design`
returned 22 upstream design commits; those exact 22 are classified below.
This is a pre-landing snapshot, not a claim about the count produced by rerunning
the query after this landing adds its own design/review commits. The ledger
scope excludes every commit created by this combined landing and its
postreview; those belong to the separate landing/review chain and do not become
upstream accepted overlays. Only
unique accepted owner overlays with fixed package hashes and B0 postreview
were replayed. Duplicate/history commits are not independent semantics.

| Full commit SHA | Accepted package / disposition | Fixed package SHA-256 | B0 postreview / proof |
|---|---|---|---|
| `865ba4ea5913efac6ccf7a8413d7f404789087f0` | Replay F21 OPEN-1/OPEN-2 exact owner package | `B50C8251D77981B2A57A4E3A15741D2024C1FEF97D8151534DB38F0DA1BB49C0` | `18a3986142ca753dd747c963d267a5ebcb7dbe14` |
| `b0a9b8ca182942ca1152d624302f467520aa4014` | Replay accepted P39 RecoveryBinding v3 | `7483A49AF7E6528D81895199CF8A15BB83FB2F7DFD4DE3797BAAB7D2A77D4600` | `4b3cb274ead7db75dba3b7861b84c2dc9ff3ac9a` |
| `d60c82ec6790c9a9ee0c3c5ff2bab56d7706ad0a` | Replay accepted P41 / migration 0041 physical schema | `589B4CD84298D5D418FF6A0DD143518EB5EB35654C324A9D9E6D0ECAF000F012` | `c0628ad41a9d565c01ab949b73c042444b5e0838` (Blocking=0) |
| `28f9c4fad0eb98ffe763113c33c757b045cae76c` | Replay accepted AH7 same-holder owner boundary | `57C522120E5E58CAE568C30A96BAE02EC10B0C5C591E8F2A6D3F568E3078FCCC` | `6e0faf53e6efa16afec26b556292ee116ffc6a20` |
| `2fb2823515cdd45ac22a9b4119a5cf371ace6ee1` | Replay accepted RAI-DG-01 exact Work-revision readmission gate | `0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106` | Independent postreview recorded at `96938db584e7a912d077b1313f117e8ad42ee32e`; prior accepted review/landing audit commit `ba8a4a7816a3262785983e073a67e1a448e6efd3` |
| `cf0fa809e872d5e89b43cfb90d140e2e35be1246` | Already represented / duplicate alternate-baseline RAI landing; same accepted package, not a second semantic overlay | `0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106` | Same RAI postreview chain as above |
| `ff949ebf4ebe8a998deaa62e454d2913d08d5747` | Already represented: accepted F21 OPEN-3 source-intent/Attention contracts are present in selected owner bytes | Existing accepted OPEN-3 owner record | `planning/results/F21-open3-governance-acceptance-and-landing.review.md` |
| `549caac096734d79c1256a44e64d1f1295ffea8d` | Already represented: F21 OPEN-3 P10 source-truth reconciliation refinement | Existing accepted OPEN-3 owner record | `planning/proposals/F21-open3-level-triggered-reconciliation.review.md` |
| `97cbf93270b2698bd3a623c6e6e9ff04839b36d0` | Already represented: P12 sensitive-read authentication boundary | Owner bytes present in selected base | `planning/results/P12-sensitive-read-auth-design-landing.result.md` |
| `ac4a1ea9fb06aa78c1cbd3fd3b166fd951257563` | Already represented: F23 exact-tuple receipt integrity | DID v1.35 accepted owner text | `planning/results/F23-exact-tuple-receipt-integrity-design-landing.md` |
| `28fa59db21c447beb8fda346a355d90198c3e590` | Already represented: F23 receipt tuple/decode ordering | DID v1.35 accepted owner text | `planning/results/F23-receipt-tuple-vs-decode-ordering-governance-landing.md` |
| `d7dd30047a33c390a56610fb0c0c4dc91ef734a4` | Already represented: F21 Profile selector UI scope | Current P1/P13 selected owner text | `planning/results/FT-DG-01-v3-functional-scope-design-landing.result.md` |
| `1526c30d9a5926cd2ec768e67ed58856262fe548` | Already represented: F21 v3 root resource-admission contract | Existing DID/P1 host-Profile/ConversationOnly source owner text | `planning/results/FT-DG-01-v3-functional-scope-design-landing.result.md` |
| `89d799025e0633aebd9e4299df172907f14cc05e` | Already represented: AH10 Deliver generation fence | DID v1.37 and P7/P9 owner text in base | `planning/results/AH10-deliver-generation-fence-design-landing.md` |
| `129782081677041526ef92be27c0a5f472f48bb2` | Already represented: AH10 Deliver P10 storage correction | DID v1.38/P10/P9 owner text in base | `planning/results/AH10-deliver-p10-storage-addendum-design-landing.md` |
| `018f766a5a34f2fa8cc1108f09f10a73594dbd8c` | Already represented: EA-DG-01 executable approval handoff | DID v1.39/P1/P4/P10 owner text in base | `planning/results/EA-DG-01-contract-landing.result.md` |
| `043b08c270b80a3b714a9cd45ad2c90100ae19ab` | Already represented: preserve approval composite key in migration 0038 | Existing P1/P4 accepted storage text | `planning/results/EA-DG-01-post-landing-review-repair.md` |
| `8e5938bd0d83e62191d7f7b9719d43d1eaa1d656` | Already represented: AH7-DG-03 approval-settlement atomicity | DID v1.39 and P2/P4 accepted text in base | `planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md` |
| `9fe9a806e264b4f4d09ac06bc51104e546c14f28` | Already represented: duplicate AH7-DG-03 owner landing | Same accepted contract as above | Same AH7-DG-03 review chain |
| `34ed1c597c02d677d87f4fa9435d8339641ea3d6` | Already represented: alternate AH7-DG-03 owner landing | Same accepted contract as above | Same AH7-DG-03 review chain |
| `3f801761f3dcaab8b3f369352e710610056967b4` | Already represented: AH7-DG-03 acceptance-record completion, no new owner semantics | Same fixed accepted proposal | Same AH7-DG-03 review chain |
| `5cab270642f3a738f1da3dcb846ce734d477f8b2` | Already represented: duplicate AH7-DG-03 decision record | Same fixed accepted proposal | Same AH7-DG-03 review chain |

The 22 rows above include five unique owner overlays replayed, one duplicate
alternate RAI landing, and 16 already-represented owner/record commits. The
four directly accepted user packages and their original hashes/reviews are
recorded in
`planning/results/2026-10-12-combined-governance-acceptance-and-implementation-authorization.record.md`.
Proposal-only branches, implementation code, migration qualification, and
unaccepted owner suggestions were not treated as design authority.

## Four exact accepted packages

| Token | Proposal SHA-256 | B0 review SHA-256 | Status |
|---|---|---|---|
| `ACCEPT_P15_EXTERNAL_PROJECT_COMMAND_ORIGIN_V1` | `E09BDF83099137BC0A694EDA5B0DEBEBAB4C821B5A51C0AB8B94A3F18CC7FECD` | `1253224F8BBCBC11FA849341B3FC4F0B5888C4B27C1D237E8C1F3F0EED406729` | Rebased to current P13/P15 owners; Agent origin denied even with grant |
| `ACCEPT_BLOCKED_WORK_EPISODE_VISIBILITY` | `818F003EC614CFAF552947C355D35D283348D417AD314E8CFC862FBCD35C3ABD` | `F8111379E41D40AB844B0F38438647585D9771ED299D5DF74F4E86EA03B60F72` | Rebased as exact WorkEpisode outcome, current WorkBlocker ledger and read-only surfaces |
| `ACCEPT_P39_DENIED_UNBOUND_PROJECTION` | `294300E103DE1EFC34B250EC41A30DC2EDDBB5671216499254695C32E6D91D1E` | `0959A76AC049048D978472382B7E7A24D264AD5CFD93C397187158341FE69F38` | Rebased within schema-39 `recovery_binding_state`; P40 evidence branches unchanged |
| `ACCEPT_P8_VERIFIER_ORPHAN_GOVERNANCE_SURFACE` | `AC0D158ED86E6ACA6F8E515CC901C022F565CBB97DA24324C914C4D2ECDA1EE3` | `1CE590D5D3F50EC20B23DFD05F9A1DBB66E4F774F5942297B46F97B8936E3A2E` | Rebased as authenticated-human-only atomic `RetryVerification` |

## Overlap and technical rebase proof

- P1 `04` is shared by F21 and P41. Both accepted fixed-package records name
  the same original preimage SHA-256
  `9748143129974644C9B717ADB6665F899B058A83FBF361FA161F0EB60802BA83`; their
  isolated after-hashes
  `E053A37B8A05390A72ED0D7C5E88E4C17D1481D6D9E4B0289B155B641D474E22` and
  `D3E81F43ACE67CC77AAB1DA068A48436F09588B1D9DA7759F73259622FB76517` are
  not claimed for the combined file. The combined P1 `04` below contains both
  additive contracts, with 0041's fully-qualified 0036→0040 gate before F21
  0042; neither migration is registered or executed.
- P13 `02` is shared by P15 and P8. The P15-only postimage
  `7D9DB199B53F53F03773EB9ACBDB8E19353B7ADDFDA3D2AD35221354836F01BA` is an
  intermediate only. The integrated catalog is 28 required descriptors plus
  one optional `ResolveControlApproval`, 15 Human-actionable, 12
  Agent-originated; it contains the exact P15 local-human-only origin and P8
  `RetryVerification` authority. No stale catalog count survives.
- P4 `06` combines P39 DeniedUnbound with already accepted P39/P40 recovery
  binding and P40 observation contracts by semantic hunk. `DeniedUnbound` is
  schema-39 provenance for terminal no-effect Denied, has no binding/digest,
  cannot gain an effect/replay, and carries no P40 observation. It does not
  create a fifth settlement tag or alter P40 Denied-null rules.
- P10 Work Detail / Attention changes are additive: Blocked WorkEpisode fields
  coexist with FT-DG-02 exact identity/not-found behavior; P8 orphan retry
  leaves `VerifierOrphan` derived and requires the existing freshness barrier.
- RAI's source-derived readmission hold and the Blocked WorkBlocker ledger are
  distinct canonical rules. A Blocked row is not a RAI source; RAI only holds
  the exact Work revision for its closed settlement/P9 source set. Advancing
  Work revision releases RAI's old revision and resolves/supersedes old
  revision blockers under their separate contracts.
- AH7 same-holder invocation ownership adds no P4/Rai source or migration;
  P15 and P8 control authorities are disjoint. EGP cleanup changes only stale
  phase owner new-write examples to the accepted four exact episode bindings.
- No semantic contradiction was found among the fixed packages or accepted
  owner overlays. All conflicts were shared-owner technical rebase/count/order
  cases above; no user choice was inferred.

## Migration / runtime boundary

No production code, test, migration registration, database upgrade, runtime
qualification, release or publication is part of this commit. Migration 0039
is not activated; 0041 remains conditional on the full P36/P37/P38/P39/P40
prefix; 0042 must follow 0041. The direct authorization and exclusions are
preserved in the acceptance record.

## Combined owner postimages

`Baseline Git blob` is the exact preimage at `ca07ee9a6ad5d3570056bbdec5fe490c25878764`;
`Postimage SHA-256` is computed from each final LF-preserving owner file in this
worktree. These are combined postimages, not proposal-specific stale hashes.

| Owner file | Baseline Git blob | Postimage SHA-256 |
|---|---|---|
| `docs/design/01-scenarios.md` | `bac30f177f4cfd102f346bcbb0a65e79980fccc1` | `A8B69E7287C21C62D21F3D48BC130EB94DEFC9AFC7C9B5AF9295997DDE73320E` |
| `docs/design/02-system-design.md` | `437edb0daeb67da4c313bd85226a7bc07bf889d5` | `427D5822B53C759565B9CF9C87C84E537796E2E09900285D2458EF0833615C79` |
| `docs/design/03-detailed-implementation-design.md` | `7dbf9770bebf319d11988095367765013a7b486b` | `E5C17EE38D32EAE1FFD671C07C07E6A1CFED3F8BAE535DFD6D96AF9E29483A3C` |
| `docs/design/implementation/MAC/02-action-approval-error-boundary.md` | `b38bfab7eb6e49f53bc13e5a918b864264e0010b` | `3539DE75480AEADB2D229136D1CF86D8914745B2C5B81B4123CDFDA897E2C2C9` |
| `docs/design/implementation/P1/01-command-contracts.md` | `379b2df5115b37dc39f17bc02082d953c73a9eae` | `48ACC35F5A7B555E657147283830600F06F152602FF772DAAF871AD97B54EFA6` |
| `docs/design/implementation/P1/02-port-contracts.md` | `d2d655fe2a423b8191829ce5900c9452fc58a152` | `99613FA5F0047FDA47BDC9939AFE14A9F4BF38E2EC3F3D7D85016B6B26620C07` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `b2f113da14747aa261c08d9ce1c864256e3fd707` | `9B198F70724E0BEF76727D00A1B289271F91C8AE3C3D02DCB5A592BFAAB9980B` |
| `docs/design/implementation/P10/00-contract-index.md` | `c91db7b84584944bce842554a47bea47d61fd17b` | `41A8B492F3CD4836B51DD32B1A44B18F43449D26DCDE2EC151F21AE88F204CB1` |
| `docs/design/implementation/P10/01-view-inventory.md` | `6e0e7a69f2f9be116b5f38f1e0061aaa3dfe5d97` | `4C87E08DF94850BDEB2C1DB9CC90C74DF13D56F9A5B8BBDA009D29676D9D11F0` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `38b5d7b394029d4d64caaf971c21d64396e3ec30` | `57A2DDB8371A6AEAB33309E4D60B86204BC8F69B346FE6F0A759A121414C33BF` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `de2da66d1d60591795267869b29a3abe719dc3a2` | `FFBE351F25D3263831CB99741609AD2CC1A1D04E37649355C9DCB56A56098AF2` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `1879567c178c965f69b76977adaa8fa55f22f25e` | `445CCF3C2E2B4D05CC2013E7B93684FBC7E0F9DA6C9B0B70552AC5F917DD374B` |
| `docs/design/implementation/P10/07-acceptance.md` | `9b2ed29b9af0bc22f2d083492ae9fed666749335` | `C9118A1002CEB9A43C3C033933000A29490057C40AC3C6BDF89E2F2385B8BFDA` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `c5f520f1d3ba9eb5bf5f3e986274d83c846bbc97` | `0CCD4DFCB98771677241998DB3D6CA52B5A7A11F7266EAE52DBCC6B331AFC150` |
| `docs/design/implementation/P12/09-region-encoding-convergence.md` | `babef920547edd6b97c6d40c7af60baf42ac636f` | `2475260FAFF90349D824021FF27C0372F1C667EBC370E52B1786E5C47BBC5987` |
| `docs/design/implementation/P12/10-transport-shells.md` | `d3a6e818881790869d1ab45f0def4cf89de86c11` | `016DF601E6562BB3C95A57B36EBDFDA7658142BEAE22A786A03A777D112AC408` |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | `206cce429572a222ffd98c9e225a2f81d758c751` | `99B55940ED85625BC36521004E2CA85ED5BAF674BF209E47EDEF849996C12D8B` |
| `docs/design/implementation/P13/03-view-rendering.md` | `82439c2a4db9a85bf9892aff5cf4b2e61968f40e` | `8D1CE8C9A897DB458C65313034498C052270286D18BE0ED3798A5078B9C2EC68` |
| `docs/design/implementation/P13/05-transport-build.md` | `05d56ace97a4aeb0aee1046f9677841be692364f` | `66B36BA460AAD30BE562863CF6DC05E0672C6C83A11B1B6352B5B9D932E83E78` |
| `docs/design/implementation/P13/06-acceptance.md` | `f4ad17fbf2f7eff054a2ff4e5d1c298b302ec63b` | `B5AB18D33ABFC01C3B834D7BED9BB7D37C4A288F31ABB89AC3F9A8A8C7F76EC3` |
| `docs/design/implementation/P15-project-management/01-project-commands.md` | `43021dd67c8a8cb8e154012d9d87b37e4ace4b1d` | `C92E8616ADD3C246F5F1026EC38831A6D457C3A2121558AAE884DAA82CA2A9B2` |
| `docs/design/implementation/P15-project-management/02-directory-read.md` | `aedaccf433c81ce37c3c8ded865ab880998219c1` | `AC9F242950E1F1ED4153178FC2571F3D927781F07B900D2075949BD0FDD5CD6C` |
| `docs/design/implementation/P2/00-contract-index.md` | `35d37917af96dc8f1909ee3d918ddcde527df769` | `7AC128981249330120C24B70BFDE7B7F1EC5D50177196A9EECF6B3797B97676D` |
| `docs/design/implementation/P2/01-command-contracts.md` | `8ffaef12d34ba2db8d60e62c0a52d641a05dabcd` | `45397EC40C674F8577AB9B76FA32C96FF1BC40EC718ED1350C43C26C5B0149A4` |
| `docs/design/implementation/P2/02-port-contracts.md` | `e44dafe85c742128bbbdd03679119432d92ebce6` | `32630700E74D1122A86E44C65993BA092FE8E67A9D701C3A2E386DA0F9DEF92C` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `550c540946a933b725c83077bd9787945052417a` | `6237D66461F6D04B8A27943A884A31F0767042F79D9F3A635C6B0CAB9A3C402D` |
| `docs/design/implementation/P2/04-sqlite-schema.md` | `a376496249f8a7e0470d6e0bebb866effbb4fa0f` | `404F851069ACEF2005024108994499DB69A942DD23D3F30CC8459D3A760141DE` |
| `docs/design/implementation/P2/05-scheduler-wait.md` | `9bd609d26a072fcee7fda9cc74442c951382c660` | `3C19C60F61B3A0B257958FE0B2155E46CEF57A2E980C2C129B597FDA24E460D3` |
| `docs/design/implementation/P3/03-agent-loop-driver.md` | `0760c66a9a440ae8544e4f26350b01ea518332a2` | `9D87387BCF23F8E07AD45068D478D25CF998C8157BDEDA8FF6F08A52DE48E039` |
| `docs/design/implementation/P3/04-sqlite-schema.md` | `9f9c04ac41f24c936c0c487dec78cb272b45896c` | `755BFF32A64489D98C84ACF6AF7865DCACE67C0E90701BA0C3C947D00E6A1A9B` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `ce0a6efe8e4eee8caaddac098f572ae6599baaa9` | `FAA03529192B69823055E02A53B42CFA52261264487CED3CEBB4528F8748220D` |
| `docs/design/implementation/P4/00-contract-index.md` | `693a057025a7a85d1b2daa4397fec41af3e4824e` | `91C623B0D629DDA4ED9FFC6196207412B7BA995460FC5B3176EF085F691A1988` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `b1188a6665349ea23ad5589c995101c5313692f6` | `34D177B624AE9B95D693692E6AC696BF23CD881409D4EE4E5106DB9637DBEA11` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `0bf7fe6a1ca4159fe7976b1648835d40e495e648` | `D029C5E9D65229562C8C465B126B1191F0697BEAED05D60B32E0333755F6A2A1` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `e8ece85a856292180fe0b7ae0dd52bc81128dfa1` | `B3F93E27AF085AF5EEED628BC05543506F70798EC93B7725CA9F47D283C7CED3` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `f81bdedb0d02cc5da272c77085bbb5e81e161b9b` | `19F7D12EEA18AE660C4BA8130021BA49D750DC6F046DAB4F79BDF067FC12ABB2` |
| `docs/design/implementation/P6/02-communication-protocol.md` | `a34ee72a8644ff71463ee48dd126487b038bf832` | `C5CBDE9ED43D059B9B6D45587760D58E2A2597EC632DB6579091F51012FBCED3` |
| `docs/design/implementation/P6/04-human-steer.md` | `2b46f2b5226b4beb40fe0373b20da5020ad9dfbb` | `F2AC9B8D33355A61200C453C00CC66914C923ED0357EE139068B5AB85C6C91AF` |
| `docs/design/implementation/P7/00-contract-index.md` | `62b42865ddc0c069ba686de53f4b7af724a23ad3` | `E08A26E305FB71515AAF7094283C741E979E8CA155B1DF9975FB20238FF3ABD2` |
| `docs/design/implementation/P7/03-runnability-classification.md` | `b4c6ef3b6d3beb7cc9f9c3051b13695cec45576c` | `FD98B66A9DE74D3A26F6E0B152CC9DD3F3F6F49998ADCAF9E437A06DC2832071` |
| `docs/design/implementation/P8/00-contract-index.md` | `f993b0024dda6016542d4b339782587a215f81ad` | `29F3E09A0F37B675366963B2405AEB623ED8D53AD2ECABCF829CA58BEB5B065A` |
| `docs/design/implementation/P8/01-verification-commands.md` | `72d209dbfac90ea3fcf02b03af5952d38d054f5b` | `793D362B21AA8FC6C06B3CBC757454EC9DC69F766FD9FF075E04D8F7C21D45F3` |
| `docs/design/implementation/P8/02-verifier-execution.md` | `54f8a87006bd851374fc40254d7a1075be342ac2` | `A45158A2E39BC06CEDFD23F814A2CF86EAF5700E57B479840D588DA88317A567` |
| `docs/design/implementation/P8/06-acceptance.md` | `82c5ab646ca51940a4b176353c55cceae8dac807` | `B774F506D885A94D1150E646796812D5C5F67CE2EE46E4F124D954658B8BF32A` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `271b4eaac997f1c9496eaae8ee5813763db1cbf0` | `1E4100F0E9572AFB8DD3C1AF4802F77D3C6FBAEEBC7D3B798798576C61E4F4A9` |

The current postimage table includes 45 design owners. The companion acceptance
record is the 46th changed path; this manifest is the 47th. The design landing
commit and independent postreview commit identities are recorded in the
postreview result after review completes, avoiding a self-referential commit
hash in this file.
