# AH10 Deliver Generation Fence — Design Landing Record

Date: 2026-10-11

Status: **accepted owner contracts landed; independent post-landing review pending; runtime implementation not authorized by this landing**

## Acceptance record

- Decision: `planning/results/AH10-deliver-generation-fence-governance.decision.md`
- Accepted proposal: `planning/proposals/AH10-deliver-generation-fence-governance-draft.md`
- Accepted proposal SHA-256: `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`
- Acceptance authority: the user's standing delegated authority for high-confidence governance changes
- Independent proposal review: **Blocking = 0** (review conclusion supplied by the parent task)
- Recorded separately and committed before owner-contract changes; that record does not authorize implementation.

## Owner landing

DID advances from v1.36 to v1.37. The fixed package maps Deliver AgentAction to the distinct `DeliverMessage/1` Gateway command while preserving P7 Message/Deliverable separation and ordinary `SendMessage/1`. P1 binds the route to generation-scoped CommandIds and receipt-first recovery, with one bounded legacy direct-write proof path. P2 applies its existing NormalExecutionMutation fence without adding a class. P7 owns DeliverMessage payload, handler preconditions, MessageSent(v1), Inbox admission and the sole MessageSent→ChildDelivered wake source. P9 owns the DeliverReplayEscalated immutable fact/event and RecoveryBlocked path. P10 owns its ActionRequired read-model source, deduplication, rebuild and acceptance story.

DID §4.1B registers the strict DeliverMessage descriptor at external wire codec v1 with External origin denied; its semantic Handler/result schema is v1. The production Command registry rises from 26 to 27. MessageSent stays EventVersion 1. Migration 0034 is additive, creates only `deliver_replay_attention_facts`, and performs no historical backfill; Command, Message and MessageSent schemas are unchanged. No design contract authorizes production or test implementation.

## Self-consistency audit

The landing cross-checks the accepted identity/receipt priority, legacy proof fields, and failure path across P1 `07`, P2 `03`, P7 `02`/`06`, P9 `07`, P10 `02`/`07`, and DID §§4.1B, 4.2, 5.3, 7.2, 9.3 and 12.10. DeliverMessage is the only new command route. All legacy FencingRejected/Committed/OperationalFailure cases use the accepted priority table. The event proof checks project, aggregate, type/version, payload and causal CommandId; any surviving Inbox row must match exact P7 fields, while a missing row after consumption is permitted. MessageSent remains the only durable wake source. Fact and event are atomic; P10 applies its projection row and offset atomically and can rebuild from P9 facts.

`git diff --check` passed. No test, build, lint, or full gate was run. No production/test file, System Design, Problem & Goals, or Scenarios file changed. Independent post-landing consistency review is still required before any implementation work.

## Owner-file SHA-256 (landed content)

| File | SHA-256 |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | `AC9F7C799D2523A5A3FB8480EFB7A1B587CFF86AF3EEE20DE3150200961A8462` |
| `docs/design/implementation/P1/00-contract-index.md` | `B58880D2331D640E87ECA0E5F6F2C97855AA32AC34B8168EE8CEF9944EBF06A7` |
| `docs/design/implementation/P1/01-command-contracts.md` | `6BFC597E3BE8A035390D61241747CF843DF492D5598C134D0571A636D28389F2` |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | `B67A8E2A442014CEF9F0F82BC392B7ED5C0C80B789F0BF3D1A6F8BF29BC55B68` |
| `docs/design/implementation/P2/00-contract-index.md` | `4F44B357AC9DAA9585F49E79ABADA80AD91F76A5F873E15603D46396A38D2A20` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `57876AE82B6A5E296AB16B953C049A1483E8383D3E036F7D17591B1598DC2A40` |
| `docs/design/implementation/P7/00-contract-index.md` | `30A0F1CF698AECFA79CBCFC87CCE877D9AE1AB5FE1669FAAD0DAEEFBC18BAA62` |
| `docs/design/implementation/P7/01-dependency-deliverable-commands.md` | `5C2E387C944E4A55A8D002B86CB90431DA0BD87BA60E80CD3208E9A4AEA2FBFF` |
| `docs/design/implementation/P7/02-deliver-primitive.md` | `B69A17F5B68546F0974BFD11E456122428711F54F5DB5CB326ACA4E1B6DE0F61` |
| `docs/design/implementation/P7/06-wake-integration.md` | `7A23D87A62BDA1FBC655D17D5EA724775E7F8297710D521E8E1E766C3AA55113` |
| `docs/design/implementation/P7/07-acceptance.md` | `32AFA348B6F69A5D7ECDA9EC273313FB3AE8866D66411B11E1D18104A12DEDF4` |
| `docs/design/implementation/P9/00-contract-index.md` | `5535CAB94A70190212386312B5985AD57487612439690A88031A6E79649244FB` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `B4F15F1A470C54B9A72DA2B888D11AF83E0732BEB8C2BB57821CDE03EC1972EA` |
| `docs/design/implementation/P10/00-contract-index.md` | `E3E096EB1282DBA72AEA9A597302B5808EAFE91A2DA6EE97E6D6E1AA5E7A8088` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `1DEC7672586A511FCE4D2B44D39A228D6CD052DD29D4FCD285162AD5E7B8399C` |
| `docs/design/implementation/P10/07-acceptance.md` | `87D690584765E13925B7640C502FCDB8B940F4BAC4C14349E152E2D5F7DC4362` |
