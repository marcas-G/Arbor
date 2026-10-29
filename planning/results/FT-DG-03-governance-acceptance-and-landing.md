# FT-DG-03 Governance Acceptance and Design Landing

Date: 2026-10-09

Decision token: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`

Accepted fixed proposal SHA-256:
`DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

The proposal digest was recomputed from
`planning/proposals/external-command-runtime-codec-decision-draft.md` before
landing and matched the manually accepted value exactly. The decision accepts
the complete fixed package, including external wire v1 without a caller version
field, exact external Actor/Principal string equality, Resolver visibility
before receipt disclosure, preserve-only/non-replayable historical malformed
CommandIds, the non-reflecting `InvalidCommandPayload` DTO with HTTP 400, the
26-command current registry boundary, its six factory-only exclusions, AH10
coexistence, and F21 / FT-DG-01 isolation.

## Accepted owner revisions and resulting file digests

| Owner file | Landing | SHA-256 after landing |
|---|---|---|
| `docs/design/02-system-design.md` | v1.11 → v1.12; add §8A.1 | `1BA12B6E1D872C44360292CBB6820493040ED4D5E601623771A85A702992EBEA` |
| `docs/design/03-detailed-implementation-design.md` | v1.33 → v1.34; depends on SD v1.12; add §4.1B | `C95E6C27E174FAA19087AEEB42F3C5C8C8C35559ECF4A1F7CF1DA14135F12E9F` |
| `docs/design/implementation/P1/01-command-contracts.md` | focused §3 amendment | `283371CBBB7D39849019BF1B2FA72A11E0F077ED6D53642F113329312F01D279` |
| `docs/design/implementation/P1/03-transaction-model.md` | focused §3.1 amendment | `FFEBD0BB62F18054BC1FC864D35327ACD6FABB0C8B2DE63E6B446BDA6FFCD212` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | focused §3.4 amendment | `96B789BD396E7BF3D75F00A6424F9C5CCB232B25C58137EECC0302364276F22D` |
| `docs/design/implementation/P2/01-command-contracts.md` | additive payload/codec reference | `BCE82CB746A8D31CB405CAF4E33E837C6E8785A98F133547EDE2677A7F605F91` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | additive approval/typed-evidence reference | `90FC6B52D35B2B4FC290149D0F721704D3100C4E44329697CA469C0A4CF4DBB3` |
| `docs/design/implementation/P5/01-composition-root.md` | additive SelectCurrentWork validation reference | `CB1179895982DC9D1F15680452AC78A3F5809AA4DDA5F68EF50B9ACAF35FBB80` |
| `docs/design/implementation/P6/01-formation-semantics.md` | additive RecordDecision validation reference | `6EB1D20C4A7F89FA33B81C7B15B6848A369C88468AB1E63612AC2A50BFF89E41` |
| `docs/design/implementation/P6/02-communication-protocol.md` | additive SendMessage validation reference | `29727E582AAE5449AB03B3BCBDA8F5FFCF8B5006DDA0C05B0B6D293D8ECB130E` |
| `docs/design/implementation/P6/04-human-steer.md` | additive SteerWork validation reference | `EA86FE575A5BD0F3AECC490ABFF32A7513E192530C6F1331E748256EB866C01C` |
| `docs/design/implementation/P7/01-dependency-deliverable-commands.md` | additive current-vs-factory-only scope reference | `309D6403B1A001091684D06C3D20A66801C9C5482ABA5AC935B45464A0C2A1A8` |
| `docs/design/implementation/P8/01-verification-commands.md` | additive payload/codec reference | `D326994816803253AEF82655FDCB82D68F5BE4AD1DA8761720E2A68AF665262C` |
| `docs/design/implementation/P11/09-worktree-lifecycle.md` | additive factory-only scope reference | `DE8CDD364A33D1E8C7D5F08368DFCED30F01585DE06777AFC585314F7E71927A` |
| `docs/design/implementation/P12/01-plugin-sdk-spi.md` | additive RegisterProjectTool factory-only reference | `F789EB03CCAE4FCAEFAB8DFDC30776D3D608761B5AAD864E459C65769B3B068A` |
| `docs/design/implementation/P12/02-authority-resolver.md` | focused external typed-input / visibility amendment | `310E153ECF50A43AE109114ADC62DCEB534CBCC2B18F48F8433228BEE241C292` |
| `docs/design/implementation/P12/10-transport-shells.md` | focused authenticated raw-envelope / shared-shell amendment | `08F4E2AB681695BA0E5C465E130529CC8C38ACCC6A5F2DB7F2988EC5130F2932` |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | codec registry separated from UI exposure | `2DC54ED3D273509873FA1CF0B7279B04D4D61569913FF21F82E486E250BB603C` |
| `docs/design/implementation/P14/01-human-message.md` | additive SubmitHumanMessage payload validation reference | `66D71E1FF5C2514AF03A1A72E0CAB6AFDFE6A406A95DDC245CE29778DC961431` |
| `docs/design/implementation/P15-project-management/01-project-commands.md` | additive RenameProject/CloseProject codec reference | `DD9DE1DA196E03AB12520B40B00E73828822D2ED46E778B0C065C63368052FEA` |
| `docs/design/implementation/P17-conversation-delivery-runtime/05-commands-projections.md` | additive response-command payload validation reference | `EA14E299F6B5D0E5AC0A13C53B11B17C5C77B24A77A9081E2F815021AA1B8ECA` |

## Registry and compatibility checks

The current production `CommandHandlerRegistry` composes 26 command types:
`CreateProject`, `CreateChildWorkspace`, `AssignWork`, `RenameProject`,
`CloseProject`, `SelectCurrentWork`, `AdmitExecution`, `StopExecution`,
`SettleExecution`, `SendMessage`, `DeclareDependency`, `ProduceDeliverable`,
`SatisfyDependency`, `RecordDecision`, `ResolveControlApproval`, `SteerWork`,
`AcceptWorkOutcome`, `CompleteWork`, `StartVerification`,
`RecordVerificationEvidence`, `ConcludeVerification`, `GrantPermission`,
`RevokePermission`, `SubmitHumanMessage`, `ResumeConversationResponse`, and
`CancelConversationResponse`. The P13 codec registry contains the same 26 names
with the accepted external origin policies.

These six handler factories are not current production registrations and have
no current codec descriptor: `ReviseDependencyContract`,
`WithdrawDependency`, `MarkDependencyUnfulfillable`, `RegisterProjectTool`,
`CreateWorktree`, and `RetireWorktree`. They remain outside the F23 qualification
matrix until a separately accepted registration/codec scope update.

AH10 remains an unchanged dependency baseline: SD §4.11, DID §6A.16, migration
0033, DID §9.9, P1 `07`, P9 recovery fact/event handling, P10 projection, and
the P4 Command-boundary ActionApproval consumption contract remain in their
owning sections. The F23 external codec cannot create AH10 trusted evidence or
change its receipt/recovery exception. F21 and FT-DG-01 remain isolated.

## Landing self-check and authorization boundary

- Design landing commit: `712b383b51fb3dee4c5aa16aba48d9f8ecd50aab`. The commit
  contains exactly the 21 accepted owner files, fixed
  proposal, readiness review, acceptance record, and the two independent
  landing reviews (26 files total).
- The fixed accepted package was applied only to the owner set named above;
  this record is the F23 planning acceptance/landing artifact.
- `git diff --check -- docs/design` passes. No test, migration, production
  code, AH10 uncommitted source/test, P12 generated file, or unrelated
  untracked file was changed for this landing.
- The transport implementation currently maps `invalid-request` to HTTP 400;
  its `validation` category currently falls through to the default status. The
  accepted DID contract specifies HTTP 400 for `InvalidCommandPayload`. The
  adapter change is an implementation requirement for a separately authorized
  implementation task and was not made here.
- **Runtime implementation is NOT AUTHORIZED by this acceptance or landing.**
  No code/test/migration scope is granted here.
- Independent post-landing reviews are complete:
  `planning/results/FT-DG-03-design-landing-semantic.review.md` and
  `planning/results/FT-DG-03-design-landing-boundary.review.md`. Both report
  **Blocking = 0** and confirm the accepted owner-file digests, cross-document
  ownership/order, 26-command registry/descriptors, six factory-only
  exclusions, AH10 preservation, and F21 isolation.
- The reviews do not authorize runtime implementation. **Runtime
  implementation remains NOT AUTHORIZED**; separate implementation
  authorization is required.

## Final landing audit

- Landing commit: `712b383b51fb3dee4c5aa16aba48d9f8ecd50aab`.
- Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`.
- All 21 owner-file SHA-256 digests match this record; the staged landing
  manifest contained exactly 26 expected files and no source, test, or
  migration paths. `git diff --cached --check` passed before commit.
- Both independent reviews report **Blocking = 0**. No implementation tests
  were run. Runtime implementation remains **NOT AUTHORIZED**.
