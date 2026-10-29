# FT-DG-03 — 外部 Command Runtime Codec 固定 Landing Package

状态：**DRAFT / 等待人工整体接受**
实施：**尚未授权**
建议接受标识：`ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`
范围：F23 与所有已注册 Command 的外部/内部运行时输入验证；不包含 FT-DG-01 的 CreateProject 资源接纳语义。

## 1. 决策请求

请整体接受下述唯一推荐合同，或拒绝并退回治理修订。不能把某个 codec、Problem 或历史收据规则单独视为已接受。该合同来源于 `planning/gaps/FT-DG-03-external-command-runtime-validation.md`、F23 失败证据、现有 P1 Command/receipt/fingerprint 合同、P12 external transport 与 Authority Resolver 合同，以及当前生产注册表。

### 唯一推荐：无新 wire 字段，固定外部 wire v1

第一版不新增 `wireSchemaVersion` 字段，不依赖客户端声明的版本，也不改变 `ExternalCommandEnvelope`。已认证的外部提交按 `(commandType, external codec contract = v1)` 选择唯一严格 codec；未知 `commandType` 返回稳定的 `InvalidCommandPayload`。将来需要不兼容外部格式时，必须通过独立治理引入明确协议协商/版本字段和旧客户端映射，不能把 `CommandHandler.schemaVersion` 或 `commands.schema_version` 偷换为 wire 版本。

三个版本/指纹概念严格分离：

| 名称 | 来源与含义 | 持久化/用途 |
|---|---|---|
| `externalWireCodecVersion` | 本建议固定为 `1`，由服务端实现按 commandType 选择；wire 不携带此值 | 不进入 CommandEnvelope、fingerprint 或 SQL；选择外部解码合同 |
| `CommandHandler.schemaVersion` / `commands.schema_version` | 当前注册 Handler 的语义 Command/receipt schema；由 Handler 注册表给出，不能从客户端取值 | 既有 P1 fingerprint 输入、receipt 字段、result/error JSON 解码键，保持原语义 |
| `fingerprint_algorithm_version` | P1 明确的 canonical serialization/hash 算法版本；当前活动算法为 1 | 既有 commands 列；与上述两种 schema version 均不同 |

外部 v1 codec 先将 JSON 解码成封闭的语义 payload；Application 再按现有 Handler 的 `schemaVersion` 与 P1 算法计算 fingerprint。相同语义 Command 的 wire 解码器修补不得仅因内部 codec 实现迭代而改变 receipt 身份。若语义字段/handler 合同变化，按现有 P1/P8/P12 owner 提升 Handler schemaVersion 并审计结果 JSON 兼容；不以 wire v1 隐式迁移旧 receipt。

## 2. 线性化与处理顺序

外部 HTTP、WebSocket、CLI 和未来外部入口共用 Application/Composition 的同一入口。Shell 只保留原始 JSON、认证 principal、submission context 和关联信息；Shell 不 cast 为可信 `ExternalCommandEnvelope`，不在 Web 表单层承担服务端保证。

推荐顺序如下。ExternalSubmission 不做 Gateway 外的 receipt 查询；P1 Gateway 的 `BEGIN IMMEDIATE` 事务是唯一 receipt 读取与线性化点：

```text
authenticate principal + establish submission origin
  → strict bounded external wire v1 envelope + registered command payload codec
      → decode typed semantic envelope or return InvalidCommandPayload Problem
      → validate CommandId/ProjectId/Actor syntax; invalid ID is rejected
  → derive Handler.schemaVersion; compute current P1 semantic fingerprint
  → enforce External Actor == authenticated Principal
  → load canonical facts / active Grants; run Authority Resolver for this exact
    typed command, project, target, origin, and fingerprint
      → denied: return existing authority Problem; do not read/reveal any receipt
  → CommandGateway begins its existing BEGIN IMMEDIATE transaction
      → read receipt by CommandId
      → exact stored fingerprint + Handler schemaVersion + algorithm version:
          return existing receipt
      → any tuple mismatch: return IdempotencyConflict; preserve stored receipt
      → if absent, in-transaction fence/stop/authority/precondition/handler/write
  → return receipt
```

This order preserves the P12 Composition boundary: no existing receipt, fingerprint conflict, result, or rejection is disclosed until the authenticated request is decoded and the current Authority Resolver has produced an exact-bound fact. The proposal explicitly binds external declared `Actor` to the authenticated `Principal` by exact string equality; a client cannot name another actor. Resolver input and facts bind principal, origin, CommandId, project, command kind, target and fingerprint against current canonical facts, policy and active Grant scope. That check is read-only and permits no mutation; it is required for visibility even on an idempotent retry. The binding and Grant checks are proposed F23 semantics and must be accepted before implementation.

Once authorized, the Gateway's existing P1 exact tuple rule is unchanged: match all three of `(semantic_request_fingerprint, schema_version, fingerprint_algorithm_version)` to replay; mismatch returns `IdempotencyConflict`; no receipt is updated. P1's single `BEGIN IMMEDIATE` transaction is the linearization point for concurrent submissions. The losing same-tuple attempt reads and returns the winner; a different tuple cannot overwrite it. No outer preflight or stale receipt snapshot can decide the race. P12 canonical preconditions and Gateway exact-authority validation remain final for mutations.

Because strict codec and Resolver precede Gateway receipt replay, a historical request that no longer satisfies the current wire v1 codec is not replayed, even when the same CommandId has a stored receipt. It receives `InvalidCommandPayload`; the old row remains unchanged. A well-formed exact current request can replay only after the current principal/Actor/project/target/Grant visibility checks. This deliberately favors non-disclosure over compatibility for malformed historical inputs.

**AH10 direct-child AssignWork coexistence (accepted 2026-10-09).** The accepted baseline is recorded in `planning/results/AH10-direct-child-assign-work-target-binding-governance.md` (proposal SHA-256 `E71285B4908DE221D10A3AA7720DEB74ABDFBD99992640AD6152F534666B0DD9`; independent landing review Blocking = 0). The external codec path does not handle the internal Agent `AssignWork` control route: direct-child AssignWork remains external-origin denied and its typed Runtime-resolved target/Grant-or-ActionApproval evidence is never accepted from JSON. The AH10 contract remains authoritative: new effect, approval single-consumption, binding, Work/event/receipt commit stay atomic under DID §6A.16/§9.9 and SD §4.11; existing receipt does not re-authorize or consume approval. P1 `07`'s sole old-Committed direct-child exception remains narrowly scoped: Recovery must validate the exact binding; a historical/missing/unprovable binding leaves Action Pending and records the accepted P9 failure fact/event, with no Observation, new Command, backfill, or repair. F23's external resolver-before-Gateway path cannot settle a LogicalAction, emit an Observation, or satisfy that recovery proof. The F23 contract adds no bypass or alternate AssignWork recovery path.

## 3. Codec, errors, and internal-origin validation

The codec registry is an Application-owned typed registry adjacent to `CommandHandlerRegistry`; each registered handler must have exactly one matching input contract descriptor and a declared origin policy. Registry construction fails closed on missing, duplicate, or extra descriptors. It must not import Web Zod schemas or infer the codec from `as` casts. Shared domain `Schema` values (especially `packages/domain/src/ids.ts` `ID_SCHEMAS`) may be reused, but the boundary returns semantic branded values only after runtime decode succeeds.

All codecs enforce exact closed object fields (including nested objects), correct primitive types, finite/integer/non-negative revision domains where the owning contract requires them, exact enums/discriminated unions, array element schemas, and every ID's frozen prefix plus UUIDv7. Optional means absent or explicitly allowed optional value according to the owning payload contract; unknown fields are rejected. Codec failures never reach Authority Resolver, CommandGateway, handler, event journal, canonical repositories, or durable `commands` receipt.

External validation failure is an outward `Problem` DTO using existing `packages/api-contracts/src/problem.ts` shape:

```ts
{
  code: "InvalidCommandPayload",
  category: "validation",
  message: "Command payload is invalid",
  correlationId: string | null,
  retryDisposition: "non-retryable",
  safeDetails: {
    commandType?: RegisteredCommandType,
    issues: ReadonlyArray<{
      path: ReadonlyArray<KnownFieldPathSegment | "<unknown-field>">,
      rule: "required" | "type" | "format" | "range" | "enum" | "unknown-field" | "unsupported-command"
    }>
  }
}
```

`RegisteredCommandType` is the finite server-owned union of command types in the current composed registry. Set `safeDetails.commandType` only when the rejected value matches that union; omit it for unknown values. `KnownFieldPathSegment` contains only schema-authored field names and array indices. For `unknown-field`, `path` ends at the known parent path followed by the fixed literal `"<unknown-field>"`; never include the caller's unknown key. For unsupported command types use the static `path: ["commandType"]` and rule `unsupported-command`, with no echo of the value. These rules apply to response bodies and all surfaced diagnostics. `safeDetails` MUST NOT echo rejected values, body fragments, credentials, absolute paths, artifact content, or untrusted exception text. Issue ordering is deterministic (safe path then rule). It is an HTTP/WS/CLI response only: not `CommandRejection`, not `TerminalRejected`, not a `CommandReceipt`, not an Event, and not a retryable attempt. Existing transport response wrapping/status policy is reused; the exact HTTP status mapping is **proposed** as 400 for malformed/unsupported wire input and must be frozen by landing review against the existing Problem/status adapter.

System/ExecutionOrigin/Recovery-origin envelope constructors do not use the external JSON codec and do not gain external Problem behavior. Each typed internal submission is checked by the same command contract descriptor's semantic validator before Authority Resolver/Gateway. A validator failure is a typed internal contract defect/Attention and creates no receipt or domain write. It must not be cast into `AuthorityDenied` or a model-retryable rejection. Gateway remains the final receipt/fence/authority transaction boundary.

## 4. Registry coverage and origin policy

The current registry is derived from the actual composed handlers in `apps/single-workspace/src/registry.ts`, plus the P1/P15/P2 factories that this composition spreads into it, and P13 `02-command-exposure-matrix.md`. At this proposal revision the current composed production registry contains 26 command types; landing review must regenerate the count and names from the final composition. A handler factory existing in source does not make its command a production registration.

| Command type | External wire v1 codec | External policy | Internal typed path |
|---|---|---|---|
| `CreateProject` | exact P1 §5 payload; all nested IDs/revisions/configuration/resource boundary fields | external human/bootstrap | CreateProject public flow; FT-DG-01 resource admission stays separate |
| `CreateChildWorkspace` | exact P1 §6 payload | reject as unsupported external origin | Formation consumer |
| `AssignWork` | exact P1 §7 payload | agent-originated; reject external | Parent Agent / formation consumer |
| `RenameProject`, `CloseProject` | owning project-management payload contracts | reject external | P15 project-management handler path |
| `SelectCurrentWork` | owning P5 payload contract | reject external | Scheduler evaluator |
| `AdmitExecution` | owning P2 payload contract | reject external by P13 v1 policy | runtime/conversation admission; external path remains unexposed and separately constrained by P13 |
| `StopExecution` | owning P2 payload contract | external human/parent path allowed; runtime path is typed internal | UI human stop and ExecutionOrigin/runtime |
| `SettleExecution` | owning P2 payload contract | reject external | ExecutionOrigin/recovery |
| `SendMessage` | owning P6 payload contract, including correlation/recipient/message IDs | reject external | Agent communication |
| `DeclareDependency` | exact owning P7 `DeclareDependencyPayload` object/union; validate DependencyId and target Work/Workspace identities | reject external | producer Agent |
| `SatisfyDependency` | exact owning P7 satisfaction payload; validate DependencyId and source evidence refs | reject external | dependency coordinator |
| `ProduceDeliverable` | owning P7 payload contract | reject external | producer Agent |
| `RecordDecision` | exact owning P6 formation decision contract including proposal ID, expected revision, disposition/adjustment union | external governance surface | external human; workflow admission/settlement |
| `ResolveControlApproval` | exact owning P4/P12 approval decision contract including ApprovalId and Approve/Reject decision | external human approval surface | external human; resumes same action/step |
| `SteerWork` | exact owning P6 steer payload; target Work identity/revision and bounded steer text | external human surface | external human |
| `AcceptWorkOutcome` | exact owning P8 Acceptance payload; `AcceptanceId` must be `acc_<uuid-v7>` and verification/work revision bindings valid | external root-parent/human path; parent-agent typed path also supported | parent Agent or human-as-root-parent |
| `CompleteWork` | exact owning P8 completion payload; Work and verification/acceptance bindings | reject external | completion consumer |
| `StartVerification` | exact owning P8 request; Work identity/revision, mission/profile and evidence references | reject external | Verification consumer/runtime |
| `RecordVerificationEvidence` | exact owning P8 evidence payload; EvidenceId, verification binding and evidence-kind union | reject external | verifier runtime |
| `ConcludeVerification` | exact owning P8 conclusion payload; verdict and complete criteria-result snapshot union | reject external | Verification consumer/runtime |
| `GrantPermission` | exact owning P12 PermissionGrant payload; grant ID, scope, issuer, lifetime and state contract | external only where P12 authority resolves the principal | external governance/permission administration |
| `RevokePermission` | exact owning P12 revoke payload; PermissionGrantId and target binding | external only where P12 authority resolves the principal | external governance/permission administration |
| `SubmitHumanMessage` | owning P14 message contract; `MessageId` must be `msg_<uuid-v7>` | external human conversation surface | external human; response-job admission |
| `ResumeConversationResponse`, `CancelConversationResponse` | owning P17 response-job contracts | reject external unless the owning P17 contract explicitly establishes an external route | P17 response runtime/recovery |

The external allow/deny column is not new authority: it restates P13 and the owning phase's declared route. Codec validity does not grant permission. `AdmitExecution`, despite external P12 authority-resolution semantics, remains unexposed under P13 U-3 and must not be silently surfaced by this proposal. Every handler in the actual composed registry receives a schema validator to prevent invalid System/ExecutionOrigin writes. The registry must contain one contract for every actual composed handler; newly registered handlers cannot become reachable before a descriptor is present. `RegisteredCommandType` and the required codec/descriptor set are exactly the 26 names above.

The following handler factories exist but are not composed into the current production registry. They are not members of `RegisteredCommandType`, receive no current codec descriptor, and are excluded from the current F23 qualification matrix:

| Factory command | Owning payload contract | Current status / future boundary |
|---|---|---|
| `ReviseDependencyContract` | P7 dependency revision payload | factory only; not production registered; if a later composition registers it, separately update/accept registry and codec scope before reachability |
| `WithdrawDependency` | P7 dependency withdrawal payload | factory only; not production registered; same future registration rule |
| `MarkDependencyUnfulfillable` | P7 terminal-dependency payload | factory only; not production registered; same future registration rule |
| `RegisterProjectTool` | P12 project-tool trust-registration contract | factory only; not production registered; landing review must not count it as current |
| `CreateWorktree`, `RetireWorktree` | P11 worktree lifecycle contracts | factories only; not production registered; landing review must not count them as current |

The three dependency factories have P7 command semantics, but adding them to a running composition is a separate registration-surface change and is outside this accepted F23 package. No future factory-only type may enter the current codec set merely because its handler implementation exists.

## 5. Historical receipts and malformed canonical IDs

No SQL migration is recommended: `commands` already persists `semantic_request_fingerprint`, `schema_version`, and `fingerprint_algorithm_version`; it does not persist raw payload, nor should this proposal add one. `command_attempts` is non-authoritative. P1's existing Gateway comparator remains authoritative and read-only on replay; it accepts only an exact current fingerprint/schema/algorithm tuple after External codec and Resolver succeed.

Before implementation authorization, a read-only inventory must classify all existing `commands` rows by `schema_version`, `fingerprint_algorithm_version`, resolution/result/error decodability, and any known deployment era/producer. The comparison table is:

| Stored row / candidate | Result after authentication, strict current codec and Resolver | Persistence disposition |
|---|---|---|
| Current Handler schema + fingerprint algorithm 1 (P1 SHA-256), exact same candidate tuple | Gateway returns stored receipt; no handler re-execution | No row change |
| Current Handler schema + algorithm 1, changed semantic payload | Gateway returns `IdempotencyConflict`; never reveal prior result through the mismatch response | Existing row unchanged |
| Historical Handler schema or algorithm (including P0 FNV if present), but candidate is valid under current wire v1 | Existing exact P1 tuple comparison applies; schema/algorithm mismatch gives `IdempotencyConflict`. No historical comparator or cross-version replay is added | Existing row unchanged; no guessing or upgrade |
| Any stored receipt with an undecodable result/error under the exact current tuple | Return a non-disclosing typed receipt-integrity Problem/Attention; do not return opaque JSON or repair the row | Existing row unchanged |
| Stored receipt exists for a payload that fails current codec | Return `InvalidCommandPayload` before Resolver/Gateway; do not query or reveal the receipt | Existing row remains read-only and non-replayable |
| Stored row uses an invalid/non-UUIDv7 CommandId | No input with that invalid CommandId reaches receipt lookup; return `InvalidCommandPayload` | Preserve the legacy row unchanged; it is not replayable |
| No stored receipt + invalid CommandId or payload | `InvalidCommandPayload`; no Resolver/Gateway | No new receipt/attempt/event/canonical write |

The current P1 fingerprint input remains exactly `{commandType, projectId, actor, schemaVersion, payload}` (DID §4.1 / P1 `01` §4). No historical raw request body is assumed. Schema/algorithm mismatch is not reinterpreted by a custom compatibility comparator: after current Resolver approval, the frozen Gateway rule returns `IdempotencyConflict` and preserves the row. There is no automatic decoder that repairs, normalizes, or rewrites an old ID.

Historical non-UUIDv7 branded IDs accepted by prior `as` casts remain byte-for-byte in canonical state, events, results, and receipts. They are not silently migrated to new IDs and do not block valid unrelated commands. Any read/query that needs to expose such a value must either preserve it as a legacy opaque value or return a typed compatibility/Attention outcome; it must not cast it to a valid branded ID. Historical malformed `MessageId` / `AcceptanceId` payloads cannot be replayed from a receipt: current External codec rejects them before Resolver/Gateway, returns no stored result, and leaves every old row untouched. The pre-implementation read-only inventory must list counts and representative command IDs/fields without copying sensitive payloads.

Whether invalid historical canonical IDs should be quarantined from projections or displayed as opaque legacy values is not uniquely specified by current contracts; this proposal recommends opaque read-only preservation plus typed Attention only where a consumer cannot safely decode. This is a proposed semantic choice requiring explicit acceptance.

## 6. FT-DG-01 isolation

This package does not authorize, imply, or depend on a CreateProject trusted resource-admission workflow. It validates the existing P1 CreateProject shape and ID/revision contracts only. An empty or insufficiently trusted CreateProject resource boundary remains the independent FT-DG-01 gap. F21 and its tests remain isolated; neither F21 acceptance nor FT-DG-01 resolution is a prerequisite for F23 codec correctness, and a passing F23 cannot close F21. Landing review must verify no shared resolver/receipt rule broadens CreateProject authority or treats FT-DG-01 as solved.

## 7. Owning documents and exact landing set

After an explicit human acceptance of this fixed package, apply only the accepted semantics to these owners (proposed next revisions; exact counters must be confirmed from current frozen heads during landing):

| Owner | Proposed landing | Required clauses |
|---|---|---|
| `docs/design/02-system-design.md` | **v1.12** (current frozen v1.11; AH10 landed) | add System Design §8A.1 `External Command Input Trust` under the Information Trust Plane; external-invalid input is data-format failure, not business rejection; no codec-derived authority; historical malformed IDs do not self-upgrade; preserve AH10 §4.11 unchanged |
| `docs/design/03-detailed-implementation-design.md` | **v1.34** (current frozen v1.33; AH10 landed); update `Depends on` to SD v1.12 | add DID §4.1B `External Command Decode and Receipt Ordering` (existing §4.1A is GovernanceChangeSet); exact distinction of codec/Handler schema/fingerprint algorithm; new non-reflecting InvalidCommandPayload DTO; Composition Resolver visibility gate before Gateway; preserve Gateway's in-transaction receipt-first-before-final-authority rule and linearization; no new SQL/raw-body addition; preserve AH10 §6A.16, §9.3 migration 0033, §9.9 and P1 `07` exception |
| `docs/design/implementation/P1/01-command-contracts.md` | next focused amendment at **§3**; separately reconcile frozen P1 `07` | §3 external Composition codec/Actor/Principal/Resolver gate before Gateway invocation; within Gateway, existing receipt-first step 3a remains before final exact authority check; exact tuple replay/conflict; no InvalidCommandPayload in CommandRejection/receipt vocabulary; must not broaden AH10's sole old-Committed AssignWork exception |
| `docs/design/implementation/P1/03-transaction-model.md` | next focused amendment at **§3.1** | external authenticated codec and Resolver run before Gateway begins; inside Gateway transaction preserve receipt-first before final authority validation; `BEGIN IMMEDIATE`, exact tuple and concurrency linearization; no receipt overwrite; preserve atomic AH10 Command/Work/Event/Binding/ActionApproval transaction |
| `docs/design/implementation/P1/04-sqlite-schema.md` | next focused amendment (no FT-DG-03 migration) | `commands.schema_version` and `fingerprint_algorithm_version` meanings; receipt compatibility inventory; affirm no raw payload / schema change; retain AH10 migration 0033 as already landed contract |
| `docs/design/implementation/P12/10-transport-shells.md` | next contract revision | raw envelope handoff, auth-before-decode, shared shells, stable Problem DTO/status, no caller wire version field |
| `docs/design/implementation/P12/02-authority-resolver.md` | next contract revision | strict decode/fingerprint before Resolver; exact external principal-to-Actor binding; project/target/Grant-scope visibility before any receipt result; resolver only sees typed envelope; Gateway final check remains authoritative |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | next contract revision | enumerate external codec registration separately from UI exposure; preserve external allow/deny origins |
| owning phase payload contracts (P2, P4, P5–P8, P11, P12, P14, P15, P17) | focused additive revisions only where absent | point to exact payload schema/closed fields; do not duplicate or invent command semantics |

`docs/design/00-problem-goals.md`, Scenarios, frozen domain business semantics, and FT-DG-01 design are not landing targets. P12 `06-remote-worker.md` is not the external HTTP/WS contract; it remains the separate authenticated worker transport contract. The P12 external shell owner is `10-transport-shells.md` (confirmed in the current P12 tree). The already accepted AH10 package remains landed at SD v1.11 / DID v1.33 and is a dependency baseline, not a target to overwrite or amend through this proposal.

ADT/Port changes if accepted: add Application-owned `ExternalCommandDecoder` (raw bounded JSON + commandType → typed semantic envelope or codec issue) and `CommandInputContractRegistry` (one closed descriptor per production Handler); remove the shell-to-Composition cast and preserve raw `unknown` only until decode. Bind external declared `Actor` to the authenticated `Principal` by exact string equality, then ensure the existing Resolver sees only the typed request with principal, External origin, project, target, active Grants and policy. Do not add any pre-Gateway receipt read, receipt-visibility bypass, historical fingerprint comparator or receipt compatibility Port. `CommandGateway` retains the existing exact tuple check inside its one `BEGIN IMMEDIATE` transaction. Internal semantic validation may be a method of the same descriptor. The descriptor cannot construct or accept AH10 `AssignWorkCommandEvidence` / `AssignWorkControlAuthorizationEvidence`, and external origin policy for AssignWork remains denied. F23 adds no migration; AH10's already-landed migration 0033 remains exactly as governed. Do not add `wireSchemaVersion`, payload/raw-envelope SQL, or a migration for F23. Any implementation discovery that requires one must return to governance.

## 8. Qualification matrix required for implementation

The following is a proposed acceptance matrix. All public tests use real daemon + HTTP/WS/CLI shell(s) and a fresh isolated DB; no test may read internal SQLite to decide the outward result. The cross-shell shared-codec property may additionally use adapter contract tests.

| Case | Required result |
|---|---|
| F23 invalid `SubmitHumanMessage.messageId = msg_not-a-uuid-v7` | 400 `InvalidCommandPayload`; zero resolver, Gateway, command receipt, Message, Inbox, response job, or Event |
| F23 valid `msg_<uuid-v7>` | existing message/conversation behavior remains Committed |
| F23 invalid `AcceptWorkOutcome.acceptanceId = acp_<valid uuid-v7>` | 400 `InvalidCommandPayload`; zero Acceptance/receipt/event |
| Valid `acc_<uuid-v7>` | existing Acceptance behavior remains |
| Invalid CommandId/ProjectId and malformed envelope primitives | safe typed Problem; no persistence |
| Negative/fractional revision, invalid enum/tag, wrong nested ID, malformed array member, unknown top-level/nested field | deterministic path/rule DTO; no Resolver/Gateway/receipt/event |
| Sensitive rejected value / exception text / secret-like string | absent from response and logs/Problem `safeDetails` |
| Unknown `commandType` containing a secret/canary string | Problem uses static text/path; omits `safeDetails.commandType`; canary absent from response and surfaced diagnostics |
| Payload with malicious unknown property key containing a secret/canary string (top-level and nested) | `unknown-field` issue path ends at known parent + literal `"<unknown-field>"`; key and value absent from response and surfaced diagnostics |
| Same ID + exact current-valid payload + authorized principal/Actor/project/target/Grant scope, prior Committed or TerminalRejected | Resolver succeeds first; Gateway returns exact stored tuple; no handler re-execution |
| Same ID + changed valid payload + authorized visibility | Resolver succeeds for the incoming request; Gateway returns IdempotencyConflict; stored receipt unchanged and prior result is not disclosed |
| Same ID + Resolver denial (including different declared Actor, project, target, or Grant scope) | existing authority Problem; no receipt/result/conflict detail revealed |
| Existing old Handler schema/fingerprint algorithm, current codec accepts candidate | Resolver succeeds; existing P1 exact tuple rule reports IdempotencyConflict on schema/algorithm mismatch; no legacy comparator or receipt rewrite |
| Existing receipt with malformed historical payload ID (`MessageId`, `AcceptanceId`, etc.) | current codec returns InvalidCommandPayload before Resolver/Gateway; no receipt result revealed; row preserved |
| New malformed CommandId with no receipt | InvalidCommandPayload; no receipt/attempt/event/canonical write |
| Historical malformed CommandId already stored | same InvalidCommandPayload; no receipt lookup/replay; row preserved read-only |
| Exact tuple row with undecodable result/error JSON | non-disclosing receipt-integrity Problem/Attention; no result disclosure or row repair |
| Race: two independent submissions, same valid ID and same semantic payload, both Resolver-authorized | Gateway transaction linearizes; loser returns same tuple receipt |
| Race: same valid ID/different semantic payload, both Resolver-authorized | one winner; loser gets IdempotencyConflict; immutable receipt and one canonical effect/event |
| Race: no row when requests reach Gateway, concurrent winner commits before loser transaction | loser re-reads under `BEGIN IMMEDIATE`; exact tuple returns winner, different tuple conflicts; never replace winner |
| all registered external-allowed Commands | representative valid and malformed contract tests; authority still decides separately |
| every registered System/ExecutionOrigin Command | valid typed caller remains same behavior; invalid constructed payload fails typed defect before durable write |
| 26-command production registry composition drift | mechanical assertion: each actual registration has exactly one codec descriptor and origin policy; no extra descriptors; the three named factory-only dependency commands are absent from this current set |
| F21 / FT-DG-01 | remain isolated; no new empty-boundary claim; F21 stays pending until its own governance |

Only after acceptance and landing review may a separate implementation authorization be requested. Implementation order: (1) add contract registry and pure codecs, (2) authenticated Actor binding and strict codec → Resolver → Gateway path, (3) typed internal validation and transport Problem mapping, (4) read-only inventory of unsupported historical rows and non-disclosing fail-closed behavior, (5) promote isolated F23 RED to default functional qualification. Do not change production code before the separate implementation token. `pnpm check`, full `pnpm test:functional`, clean clone/frozen install, and explicit two-process concurrency cases are required at implementation closure; do not report F23 closed from pure schema tests alone.

## 9. Governance sequence and unresolved proposals

Required sequence:

1. Human governor reviews and accepts/rejects this exact proposal SHA as one package.
2. If accepted, record decision token, accepted SHA, date, target owning docs/revisions; apply only those accepted clauses to `docs/design/**` under the AGENTS.md delegation exception.
3. Run independent landing consistency review (all seven blockers in prior readiness review = 0, cross-doc term/source check, actual registry coverage, no FT-DG-01 coupling, no docs outside accepted owners).
4. Request separate implementation authorization. Acceptance and landing alone do not authorize code/test/migration work.
5. Implement and qualify the matrix; close FT-DG-03/F23 only with production-boundary evidence.

Choices that current contracts do not uniquely determine and therefore remain explicitly proposed for the human governor:

1. This package recommends fixed external wire v1 with no caller version field. Rejecting that choice requires a new/edited package with explicit old-client mapping, not an implementation-time option.
2. External `Actor == authenticated Principal` exact string equality is the recommended visibility binding. DID/P12 distinguish Actor and Principal but do not freeze this equality rule; acceptance must explicitly cover it.
3. Historical malformed CommandIds and malformed payload receipts remain immutable, opaque, and non-replayable. This is the single replay policy in the package, not a later implementation choice.
4. Exact HTTP status for `InvalidCommandPayload` and operator Attention delivery for undecodable receipt data remain proposed: HTTP 400; operational Attention through non-command diagnostics, never a fabricated command event.
5. Whether currently optional P12/P17 registry branches are production enabled in every deployment. Landing review must classify the actual composed registry; it cannot infer optional absence from types alone.

These are not accepted semantics yet. Any new choice, changed recommendation, or implementation discovery needs human governance review before docs/code are changed.
