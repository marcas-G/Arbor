# F23 P6 UnboundLegacy Governance Inbox Mechanics — post-landing consistency review

Date: 2026-10-17
Accepted token: `ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`
Accepted proposal raw SHA-256: `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`
Review type: post-landing consistency review; not an independent review

## Scope and checks

Reviewed the accepted package against the single P6 definition, P8 reference,
P1 transaction/schema ownership, P12 current-authorization rule, and DID v1.47
summary. `git diff --check` is clean. `rg` finds one P6 route qualification
item in P8 `06`; the former duplicate route-addendum bullet was removed.

## Findings

- **Blocking: 0.** Existing `Governance` kind and stable key are reused; no
  enum, P10 Attention, wake, Agent consumer, or authority exception was added.
- Current canonical Work/Workspace route and P8 human authorization govern
  visibility; the Inbox row grants no authority and reads do not consume.
- Route movement is same-P1-transaction only. Unavailable movement uses the
  existing Gateway terminal-rejection receipt/attempt path and does not mutate
  canonical Work/Workspace/Event/Inbox/disposition state. No pre-Gateway
  receipt read, asynchronous repair fact, or broadened replay authority was
  introduced.
- The disposition's source Work/Verification identity supports reconstruction
  without receipt decoding or Event retention. Physical Inbox `revision`/
  `updated_at`, initial revision seed, and migration ID/name are explicitly
  implementation-package TBD in P1 `04`; no values or DDL were invented.
- P8 Story H contains one route qualification addendum, with route/query,
  Gateway replay, crash, rebuild, and physical-package-gating assertions.

No production implementation, DDL, migration registration/execution, tests,
or online database change is included or authorized by this landing.

## Landed document raw SHA-256

| Document | SHA-256 |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | `13468E8314D87BA91238F7D5659CB5B5F3BBBC25981490A51C46AB0A5EF51AD7` |
| `docs/design/implementation/P1/01-command-contracts.md` | `DB838FC2A86F96326DB172893537A29D28A8EF9EB45BE1983D94064D24291896` |
| `docs/design/implementation/P1/03-transaction-model.md` | `9E8BA8443FFAD2E575F5BFD05768C2DD2935E0EB6625C5E3B82123BEF6CC5C0E` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `9AA7F18F913D21FE033E567CC81C5BC1DFD57C9C72308A43FA08A67079B705F2` |
| `docs/design/implementation/P6/00-contract-index.md` | `B2F5AB5A3F018D2B9878D350B96CA454088C37D9EA40AFAA763DDAEAC2F43155` |
| `docs/design/implementation/P6/02-communication-protocol.md` | `A8DAEB77C59AF93480DECA84CC8ED85B71FD072DA07023901DBE399B129CA313` |
| `docs/design/implementation/P6/06-acceptance.md` | `431DA6D1E24A8D268EF90B6E528E07EF37D73242C0DDFA1AFCD3FD49D8D45742` |
| `docs/design/implementation/P8/01-verification-commands.md` | `D839991C35C69AD0D1B0FB98A081DC1656E1E481B6669F0D16EA00E90A4A506A` |
| `docs/design/implementation/P8/06-acceptance.md` | `1BFD7F0D04994F7527C0E5436DBA64EB202295342CD15D9EEED7672ABDD42855` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `71D004D7037D68065178DA1578362EC012EE4621A231B3F9A2D5CB07CAB404CC` |
| `docs/design/implementation/P12/10-transport-shells.md` | `5F86A27DD19A7BC53043F8272B16E487E1D1A74FFA8C732F1CB6FC0E045578BC` |
