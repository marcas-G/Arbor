# Gray-Box Integration Matrix

**Audit date:** 2026-09-27

“Proven” below is limited to the named seam. It does not imply that the
corresponding capability is L3-proven.

| Chain | Existing evidence | Provider mode | Real persistence / Runtime | Seam status | Missing next edge |
|---|---|---|---|---|---|
| Human Input → Session → ModelContext → ProviderRequest | New `tests/capability/gray-box/b01-public-conversation.test.ts` posts authenticated `/commands`, ticks the production daemon, and reads `/views/transcript`; P14 request/manifest tests cover context composition | RECORDING; historical Human Input run REAL | SQLite + production daemon + public HTTP transport | INTEGRATION_PROVEN for external submission, durable Assistant transcript, duplicate submission, and request assembly | Real model behavior remains B01 L3 |
| ToolInvocation → ToolRuntime → ToolObservation → next context | P4 integration, P12 list tool, P3 decoder/driver tests | NONE/RECORDING | Real P4 pipeline and sandbox in selected integration tests; scripted provider elsewhere | INTEGRATION_PROVEN for deterministic invocation pipeline | Real model selection, observation correlation, next real turn use; B02 S01 qualification is unauthorized |
| Control Tool → AgentAction → Application → durable effect | P6 SendMessage/formation integration uses direct Application paths | NONE | Application + SQLite in tests | **BLOCKED_BY_IMPLEMENTATION** for the adopted control route; legacy/direct Application evidence remains supporting L2 only | ControlToolRegistry/AgentAction route is not implemented or authorized |
| Message body → BlobStore → Message → Inbox | New `tests/capability/gray-box/b06-blob-message-inbox.test.ts` stores bytes through `BlobStorePortLive`, submits the returned ref through `SendMessage`, and reads Message/Inbox stores | NONE | Local BlobStore + SQLite Message/Inbox | INTEGRATION_PROVEN for the body-reference durability chain | Model-selected SendMessage and Parent cognition remain blocked by control-route implementation |
| Session/history → continuity context | P5 Session tests; P14 answered-turn request-composition test | NONE/RECORDING | SQLite | INTEGRATION_PROVEN for persistence and request assembly | Real same-session recall, unrelated-session isolation, and (for B12) restart then recall |
| Verification evidence → durable EvidenceRecord | P8 start/conclude/acceptance suites | NONE | SQLite and Application commands | INTEGRATION_PROVEN for schema, authority, and lifecycle mechanics | Resolvable selected observation identity, durable summary association, model judgment |
| Restart → recovery → continuation | P5 restart; P9 recovery/fault suites | RECORDING/FAKE | Real SQLite and recovery/runtime components | INTEGRATION_PROVEN for recovery/reconciliation invariants | Real daemon restart followed by a real model turn using the correct frontier |
| Web/API → transcript projection | P13 HTTP e2e; P14 transcript/pagination/UI tests | NONE/RECORDING | Real HTTP composition in P13; real DB projection fixtures | L3 for narrow P13 HTTP claims; L2/L1 for P14 components | One full external Human input → real Assistant reply → transcript/page merge story |

The integration matrix is not a substitute for the case card's external
oracle. A recording provider may prove request composition and effect wiring;
it cannot prove semantic choices.
