# Governance P36–P38 Integration Result

Date: 2026-10-11  
Scope: Phase 1 only — integrate accepted P36 AH7-DG-03, P37 AH10 Deliver,
and P38 EA-DG-01 owner contracts and their proposal/decision/landing records
onto the green `f80ee9132774c0c1fb570744d81398fad17da188` baseline.  
Status: **Integrated in an isolated managed worktree; post-integration
independent consistency review remains open.**

## Integration target and boundaries

- Managed worktree: `C:\Users\ThinkPad\.codex\worktrees\governance-p36-p38\Arbor`
- Branch: `codex/governance-p36-p38-integration`
- Start: `f80ee9132774c0c1fb570744d81398fad17da188`
- Phase 1 HEAD before this result commit: `0f5b52b83e50d651bebf98abe5634d20cbc03af3`
- Final System Design: v1.14. Final DID: v1.39.
- The source tree at `C:\Arbor` was not changed. No production, migration
  implementation, test, or deployment files were changed. No tests, builds,
  migrations, or push were run.
- No P39/P40 owner contract was landed.

## Source-to-integration commit mapping

Only the following source commits were selected. The official P36 `34ed1c5`
and `5cab270` are retained; the EA donor's `9fe9a80` re-landing is not used.

| Package | Selected source commits (in order) | Integrated commits (in order) |
|---|---|---|
| P36 AH7-DG-03 | `ce08b55`, `0aa8c20`, `34ed1c5`, `5cab270` | `1205b86`, `21a44a9`, `51d30e0`, `46526d5` |
| P37 AH10 Deliver | `5065c59`, `9a3bee8`, `9ef5fef`, `3536a6b`, `5bb5513`, `89d7990`, `0e6d8a5`, `d5649e9`, `1297820`, `fdf25c8` | `99d9f22`, `781c37f`, `85120ea`, `564858c`, `5e2391f`, `357a345`, `b4772b7`, `a67b6ac`, `25cec33`, `5ee9659` |
| P37 planning record | `97a61cf` | `d6fbf16` |
| P38 EA-DG-01 | `0fd5a2c`, `b7de979`, `7fa0545`, `1b83d5f`, `018f766`, `3f96dd7`, `f0a6fe2`, `043b08c` | `e3e8e10`, `b306aa6`, `ed4f34b`, `60af2bb`, `ffd1b70`, `dbceab6`, `67113d6`, `0f5b52b` |

The P37 sequence includes its exact proposal, review, acceptance, original
landing, P10 storage addendum, accepted correction, landing records, and
qualification plan. The P38 sequence includes proposal/review/decision,
owner landing, landing result, record cleanup, and the 0038 composite-key
preservation repair.

LF-normalized source proposal SHA-256 checks all match their acceptance records:

| Package | Accepted proposal SHA-256 |
|---|---|
| P36 AH7-DG-03 | `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE` |
| P37 AH10 Deliver | `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565` |
| P37 AH10 P10 addendum | `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B` |
| P38 EA-DG-01 | `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB` |

## Same-file integration review

Cherry-picks completed without a manual conflict-resolution stop. The P37
commits auto-merged the P36/P37 shared P2/P9 files; P38 auto-merged P9's
contract index. The shared owner set reviewed was:

- P36/P37: P2 `00`, P2 `03`, P9 `00`, P9 `07`.
- P37/P38: DID, P1 `00`/`01`/`07`, P2 `00`/`03`, P9 `00`/`07`, P10
  `00`/`02`/`07`.
- P36/P38: P2 `00`/`03`, P3 `00`/`08`, P4 `00`/`01`/`02`/`03`/`06`,
  P9 `00`/`02`/`07`.
- All three: P2 `00`/`03` and P9 `00`/`07`.

The final P9 `00` deliberately retains the official P36 authority reference
to P4 `03`. Compared with donor tree `043b08c`, this is the sole difference
under `docs/design/**`: the official DG03 contract owns that approval/authority
clause, and the donor's `9fe9a80` copy omitted the reference. The integrated
hash is `927045E103E27FBFABDB75EEEBDE37B427E743CB2599274A82CDA22EADDAF36F`.
No P36 clause was replaced by the EA donor re-landing.

P38's final 0038 repair preserves the existing
`action_approvals_id_project` composite unique key required by the 0033
AssignWork target-binding foreign key. This remains an owner-document contract;
no migration was implemented or run.

## EA 37-owner-file digest check

The EA landing record's 37 owner files were compared with the integrated tree.
At the initial P36–P38 integration, 36 hashes matched the repaired EA landing
manifest; P9 `00` differed as described above. The review disposition below
also clarifies DID §9.3's integrated-owner versus unintegrated-migration status,
so the current tree has two expected differences from the EA-only manifest:
P9 `00` and the DID v1.39 file. The table records the current SHA-256 values
for all 37 EA owner files.

| Owner file | Integrated SHA-256 |
|---|---|
| `docs/design/02-system-design.md` | `3C77A61E3EBCAD40D58DF075FB12F994881A079987C00FD21C516819AA4363E6` |
| `docs/design/03-detailed-implementation-design.md` | `95725F895663E29556E1FB03666951CAB9AD971D48FAB7A97A60F1B4B5283FBD` |
| `docs/design/implementation/MAC/00-contract-index.md` | `441D188029576F904424D35316D63D359CB3EF4C0161266F201CBDA25C073E09` |
| `docs/design/implementation/MAC/02-action-approval-error-boundary.md` | `356FE87C59F48932810D41F94171734D1B0BE1D66BF6C16F1A797146192170AE` |
| `docs/design/implementation/P1/00-contract-index.md` | `B3426A325155D743E73608A455AE0157C26AEEF94E8591D2AE4C1D4606FD45AF` |
| `docs/design/implementation/P1/01-command-contracts.md` | `A5666AC326A8EC98E6F18D5288C718CCA9C4BE8881AA1575F0E4955552FF37F8` |
| `docs/design/implementation/P1/03-transaction-model.md` | `506F00A12D6F6A13452031E4DABA5F8D884AF0159071CCBA0D9DA855CB01E87B` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `BDFC45FF41B46784C1174B2C392656989DD7B31C0C6433CCAE242F752EA53F98` |
| `docs/design/implementation/P1/05-event-journal.md` | `950558B45B3B44CDF99DA940EC9B39F7A1A3593081BCF85EF0D667BEA1177E3A` |
| `docs/design/implementation/P10/00-contract-index.md` | `1349D6F222D7D473B247F8B4F6DC9145F8ABE4D963538101ABFA0D92AA64A311` |
| `docs/design/implementation/P10/01-view-inventory.md` | `5E13028334710ED0AD9A14A4BABAE7B44185717C15ABDCB073F885238F8273B7` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `F5E151B7165FC55B783A7581D54839D9F6A27404815B33C86E7E4B695FAF6C12` |
| `docs/design/implementation/P10/07-acceptance.md` | `B38DD625B177FC613C004B684C4B842B8A7FED2DE96E70BCEE53D25888B379F6` |
| `docs/design/implementation/P12/00-contract-index.md` | `70D1B2055BFCE67103C3A51761520997FEC0B2DA99A0323E0CAA7C2942982E4E` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `4691E7433926E612963CB2FB38386211F6D081A55ED96C165B9650DDB40D621C` |
| `docs/design/implementation/P12/10-transport-shells.md` | `1EEEB2D4BD6F86BC9DA5C5FB5FED2CF9A9C593504D15C9860FF309F2F76D3C3E` |
| `docs/design/implementation/P17-conversation-delivery-runtime/00-contract-index.md` | `9CA7F78AB0C3BCFA460394296DBACB2B920BD37A4A4C3B258765656D031B0773` |
| `docs/design/implementation/P17-conversation-delivery-runtime/03-recovery-scheduler-breaker.md` | `83505BF83E8EE3813BBF87BF287174F2A1ACF9A7623F646946A1F08BA8EF9D47` |
| `docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md` | `C770D923681538AB726DD74C2E7E672FE5AC1E90A60CAFBD4B558DE751F5B832` |
| `docs/design/implementation/P17-conversation-delivery-runtime/07-acceptance.md` | `DC29FD5108BBC794A5418B2AE18FA403DBEE9F333AA97C8ED6663F9B923F536C` |
| `docs/design/implementation/P2/00-contract-index.md` | `D28FA79B462FE54543D61F61FE629F54E7A83E8298B87C518DC37BACECE4B1CB` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `4D84EF88C3B6300E1F2423438F303F3FE67F8694FEDD9A225206F44048F788B9` |
| `docs/design/implementation/P2/05-scheduler-wait.md` | `1C354CC64872BE6D9F55D7E87ACE61A8570DD896F1D4ED35DDEE42A5DBEFB4B1` |
| `docs/design/implementation/P2/06-recovery-skeleton.md` | `6F4307A347F9AD352D9A64DD19F8D3D186AFFB882F7F43681C5C442A8D824391` |
| `docs/design/implementation/P3/00-contract-index.md` | `3C53D73326A19C06522FAD9A3811A8D07F46B42196557CAD2B06488DAA65E97C` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `6903AF3E9EA8D9007BBE1560D5843CB0497E4093565A44550DC2ACF5894E4517` |
| `docs/design/implementation/P4/00-contract-index.md` | `E4EFF560A034B3C59D0D5CB3001EBF5B0A8F2E4055BD977D3FFBB002C6682766` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `34FBF1177982C972274ED67AB6EC8CE1E6ACC067290F27EC2D3B3EF72E59C4FA` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `F13F448B89F3280E75AD950200D19995F958C5B5FE29D5B23DFB40462E3D6793` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `D58C9ADC54B73467C674B7DD2DA896D0FC056176F48BE6FA754772C80DB2A242` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `513A79F92710A0D21232465CDF49E4B1678BD061CD5FEC5BC69A1BCA86EAD400` |
| `docs/design/implementation/P6/00-contract-index.md` | `3FE68C73531BDA0E9D24908D03E0926DC7C50CF5E46F218CFAE239A6518A9FC1` |
| `docs/design/implementation/P6/02-communication-protocol.md` | `66243BEA99EE5BEBFB7C156B134A21252C9EABFC245B28A4E42203FB1B071476` |
| `docs/design/implementation/P6/06-acceptance.md` | `AF1EAADE638E4FB26769B19C00EA5391CE1AB61AA3B349E4927690510B820279` |
| `docs/design/implementation/P9/00-contract-index.md` | `927045E103E27FBFABDB75EEEBDE37B427E743CB2599274A82CDA22EADDAF36F` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `547701348EF28443FBAF4A7B133332AD690296E4E97BB59EAC445B177EB6FEA6` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `97639ABBF258D305548C308342AB63DDB3D6F26E337AD488708453CF48EDF3B9` |

## Checks and remaining gates

- Commit ancestry is linear from `f80ee913` through the selected P36→P37→P38
  sequence. The official P36 source commits were cherry-picked, so their
  source SHAs are not ancestors; the mapped landing/record commits
  `51d30e0`/`46526d5` are ancestors of the integrated HEAD. Donor re-landing
  `9fe9a80` is not an ancestor.
- Owner-document `git diff --check f80ee91 HEAD -- docs/design`: PASS.
- Whole-scope `git diff --check f80ee91 HEAD`: reports existing trailing
  spaces in the exact accepted P36 proposal/decision text and one blank line
  at the end of the AH10 decision record. Those bytes are preserved because
  the proposal hashes are acceptance identities; the normalized proposal
  hashes above still match. No whitespace cleanup was made to accepted source
  artifacts.
- Changed paths are limited to `docs/design/**` and the accepted
  `planning/proposals/**`, `planning/results/**`, and `planning/tasks/**`
  records. No implementation migration was registered or copied from the
  separate P36 implementation tree.
- P36 post-landing consistency review and P38 independent post-landing
  re-review are still open. P37 design landing review is recorded, but its
  runtime/migration qualification remains separately gated. No P36–P38
  runtime or migration qualification is claimed by this result.

## Independent review disposition

The integration review reported Blocking = 1: P7 `02` still attributed the
DeliverReplay fact table to migration 0034, although 0034 is P10 Attention
materialization and the accepted DID v1.38 addendum assigns the Deliver fact
and P10 marker to proposed P37 / migration 0037 after P36 / migration 0036.
The exact accepted addendum is `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.

Disposition: P7 `02` now marks the former 0034 statement superseded and records
the accepted 0037-after-0036 sequence. P7 `00` now indexes the v1.38 storage
addendum. DID §9.3 now distinguishes the integrated P36 owner contract from
the migration 0036 implementation/registration, which remains unintegrated.
These are documentation corrections to the accepted P37 addendum and current
integration status; they add no new behavior or migration semantics.

| Updated owner | SHA-256 after review disposition |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | `95725F895663E29556E1FB03666951CAB9AD971D48FAB7A97A60F1B4B5283FBD` |
| `docs/design/implementation/P7/00-contract-index.md` | `8BEC5B0D93489E95668AC9C360DF1931823ECD5A9CB3B03C23C6EEFC0B95F00B` |
| `docs/design/implementation/P7/02-deliver-primitive.md` | `ADD1FEA5A069DDA16914CB836215B1F5CD6DE052189637B48C4C130374090ABA` |

The independent review reported semantic Blocking = 0 and governance-scope
Blocking = 1 because P7 was outside the P37 addendum's original owner list.
The exact P7 correction is accepted under the user's standing manual-governance
delegation; decision and owner hashes are in
`planning/results/AH10-deliver-p7-migration-reference-correction-governance-decision.md`.
The source accepted P37 addendum SHA is
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.

## Final independent review disposition

The independent final review returned **Blocking = 0**. It verified the
accepted P7 migration-reference correction and its separate governance-scope
decision record against DID §9.3 and the accepted P37 addendum. The integrated
P36–P38 design baseline is ready as the starting point for the separately
accepted AH7-DG-02/P39 and AH7-DG-01/P40 owner-contract landing work.

This disposition is design-only. P36–P38 migration implementations are not
integrated in this tree; P39/P40 migration implementations, migration-runner
qualification, Windows/local-filesystem durability qualification, and release
qualification remain open. No implementation or deployment readiness is
claimed.
