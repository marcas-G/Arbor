# EA-DG-01 — Executable Approval Contract Landing Result

Date: 2026-10-11
Status: **Design owner landing recorded; independent post-landing review pending**

## Identity and scope

- Fixed proposal LF SHA-256:
  `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`.
- Acceptance record: `planning/results/EA-DG-01-governance-acceptance.md`.
- Landing commit: `018f766a5a34f2fa8cc1108f09f10a73594dbd8c`.
- Migration slot: new `0038_executable_approval_handoff`, after unchanged
  `0032`, integrated P36 `0036`, and conditional P37 `0037`.
- `git diff --check` passed before landing. No tests, builds, or full gates were
  run. No production code, migration implementation, tests, `docs/design`
  outside the accepted owner list, or `C:\Arbor` files were changed.
- Independent post-landing semantic consistency review remains pending; this
  result does not authorize implementation or claim AH7/P9/Executable
  qualification.

## Changed owner files and post-landing SHA-256

| Owner file | SHA-256 |
|---|---|
| `docs/design/02-system-design.md` | `3C77A61E3EBCAD40D58DF075FB12F994881A079987C00FD21C516819AA4363E6` |
| `docs/design/03-detailed-implementation-design.md` | `0460084E149D31A0379975486E4A43A7681ECAB7CCF4319E54C4F7789F67AF43` |
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
| `docs/design/implementation/P9/00-contract-index.md` | `6317F2E1D37A18A96AAEB3322A700ACD195AAFD52E3B52549E8CF52F9464CA60` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `547701348EF28443FBAF4A7B133332AD690296E4E97BB59EAC445B177EB6FEA6` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `97639ABBF258D305548C308342AB63DDB3D6F26E337AD488708453CF48EDF3B9` |

## Verification and limits

- `git diff --check`: PASS for the design diff before commit.
- Owner changes are exactly the 37 files above; one section-order correction
  in P2 preserves the existing `Out of scope` section number.
- A post-landing reviewer identified a missing preservation clause for
  0033's `action_approvals_id_project` composite unique key, required by the
  existing AssignWork target-binding FK. The follow-up repair and owner-file
  hashes are recorded in
  `planning/results/EA-DG-01-post-landing-review-repair.md`; no new semantic
  decision was needed and neither 0033 nor Control semantics changed.
- No tests/builds were run. No production or test files were changed, and no
  push/merge was performed.
- Required next gate: independent post-landing consistency review. Any issue
  outside the fixed accepted package returns to manual governance.
