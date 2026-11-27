# 命名词汇表 — P/AH 编号到语义名的映射（object 11 / ratchet 第 3 步）

状态：owner 已裁决（2026-11-27），本文是
[semantic-naming-policy.md](semantic-naming-policy.md) 第 3 步"one concept, one
term"的落地词表。本文只记录映射，不改代码；重命名按 policy 的 ratchet 顺序分批执行，
每关闭一条即从 `scripts/governance/naming-baseline.json`（path 509 / symbol 61 /
test-name 323）删除对应条目。

Owner 三点裁决（本文全部遵循）：

1. Phase 编号（P0–P17）与迁移编号（P1–P57 符号前缀）**强行统一**，都造语义名。
2. 无设计定义的纯迁移号（P53/55/56/57、P21/24/27/28/30 等）、AH56、P54 裸
   describe **全部造名**——从迁移 DDL / 测试内容反推真实行为命名。
3. SQLite CHECK 字面量 `P36Backfill` / `P39Claim` / `P39Admission` **保留不动**
   （被重放门消费的持久化数据格式），单列"数据格式例外"一节。

引用规模（2026-11-26 盘点，全仓 .ts/.md 合计）：P4≈3327、P10≈2683、P9≈2750、
P12≈2063、P39≈1429、AH7≈980、AH10≈852、AH19≈506。符号侧：camelCase 178 个、
SCREAMING 常量 220 个、AH 边界标签 87+35、ARBOR_ 环境变量 92（其中带编号 19）、
p*/ah* 文件名 475。

## 映射原则

- 按当前真实职责命名：名字对应今天存在的角色，不对应它出生时的 phase/迁移单。
- 同概念同术语：一个概念在各层（文件、符号、Service key、测试名、环境变量）用同一个词。
- 编号降级为追溯：P/AH 号、DID 版本、契约文档号只活在注释、commit、设计文档和
  migration register 里，永不进入新写的软件名。
- 已有迁移 register `name` 字段（snake_case DDL 名）即官方语义名；TS 符号取其
  PascalCase 形式，不再发明第二套词。
- 真实版本/算法语义的数字（schema-v57、sha256、decode-turn-v1）合法，不在本表范围。

## 1. Phase 区（P0–P17）

定义出处：`docs/design/03-detailed-implementation-design.md` §11 phase 清单
（P0–P14），P15/P16/P17 各自的 contract index。"受影响面"为携带该 phase 编号的
生产符号 + 测试文件的估计数。

| 编号 | 语义名 | 定义出处 | 现有符号→新名（举要） | 受影响面（文件数估计） | 备注 |
| --- | --- | --- | --- | --- | --- |
| P0 | FunctionalDomainKernel | docs/design/03-detailed-implementation-design.md:7030 | 无 P0 前缀符号 | 0 | 纯域层，编号只出现在文档引用 |
| P1 | PersistenceCommandCore | 同上 :7046 | `P1CommandDependencies`→`PersistenceCommandDependencies`（application/src/commands/registry.ts:44）；`P1_MIGRATIONS`→见迁移区 1 | ~13 | |
| P2 | ExecutionSessionKernel | 同上 :7059 | `P2CommandDependencies`→`ExecutionCommandDependencies`（execution-runtime/src/commands/registry.ts:22）；`P2_MIGRATIONS`/`P2_DDL`→见迁移区 2；测试名 `P2-015 recovery skeleton`→`recovery skeleton` | ~7+测试 | lease/fence/恢复语义已在符号名里 |
| P3 | ProviderModelContextLoop | 同上 :7088 | `P3_MIGRATIONS`/`P3_DDL`→见迁移区 3 | ~2 | provider 系符号大多已语义化 |
| P4 | ToolRuntime | 同上 :7110 | `P4SandboxOutcomeReadPortLive`→`SandboxOutcomeReadPortLive`（persistence-sqlite/src/p4-sandbox-outcome-read-port.ts:237）；`P4OutcomeProbe`/`P4FenceProbe`→`ToolOutcomeProbe`/`ToolFenceProbe`；wire tag `P4NoEffectDenied` 见例外区 | ~25 | 全仓最高频编号（≈3327 引用） |
| P5 | SingleWorkspaceVerticalSlice | 同上 :7151 | 无 P5 符号、无独立迁移 | 0 | integration phase，只 wiring |
| P6 | ResponsibilityTreeFormation | 同上 :7173 | `P6InboxRebuild*`→`OfflineInboxRebuild*`（apps/single-workspace/src/p6-inbox-rebuild.ts:48）；`P6ProgramFamilyId`→`FormationProgramFamilyId`（agent-runtime/src/prompt-programs.ts:13，其字符串值见例外区）；`P6FixtureContext`→`FormationFixtureContext` | ~19 | 环境变量见第 4 节 |
| P7 | DependencyDeliverableCoordination | 同上 :7193 | authority source tag `P7Coordinator` 见例外区；`P7_MIGRATIONS`→见迁移区 6–7 | ~23 | |
| P8 | AgenticVerification | 同上 :7212 | `P8ProgramFamilyId`→`VerificationProgramFamilyId`（prompt-programs.ts:20，值见例外区） | ~27 | |
| P9 | RecoveryHardening | 同上 :7230 | probe stage 串 `P9ActionMissing`/`P9StepNoLongerActionable`/`P9PinnedManifestMismatch`→去前缀（`ActionMissing`…，agent-loop-actions/ledger.ts:262、durable-control-action-effect.ts:96） | ~5 | AH1–AH19 归 P9 07 拥有，见第 3 节 |
| P10 | ProjectionViews | 同上 :7255 | `P10FixtureDeps`→`ProjectionFixtureDeps`（tests/support/p10-fixture）；`P10AfterDeliverAttentionConsumerCommit`→`AfterDeliverAttentionConsumerCommit`（application/src/attention-poll-loop.ts:82）；测试名 `P10-004 …`→去编号前缀 | ~31 | |
| P11 | EnvironmentGitSandbox | 同上 :7285 | `P11B_MIGRATIONS`→见迁移区 9–10；`P11B_BASELINE`→`EnvironmentChangesSchemaBaseline` | ~10 | |
| P12 | ProductionExtensibility | 同上 :7301 | `P12CommandDependencies`→`ProjectToolGovernanceCommandDependencies`（registry.ts:180）；`P12_MIGRATION_BASELINE`→`PermissionGrantsSchemaBaseline`（ports/src/health.ts:14） | ~42 | |
| P13 | ProductWebClient | 同上 :7332 | 无 P13 符号 | 0 | apps/web 无编号泄漏 |
| P14 | ChatWorkspaceConversation | 同上 :7346 | `P14_MIGRATION_BASELINE`→`HumanMessagesSchemaBaseline`（health.ts:18） | ~3 | 交付语义已被 P17 取代，历史文档引用保留 |
| P15 | ProjectManagement（phase）/ ProviderRuntimeCorrectness（migration 15）——双语义 | docs/design/implementation/P15-project-management/00-contract-index.md:1；撞号记录 docs/design/implementation/P16-provider-extension/01-provider-extension-contracts.md:3 | phase 侧：`P15CommandDependencies`→`ProjectManagementCommandDependencies`（registry.ts:101）；migration 侧：`P15_MIGRATIONS`→`ProviderRuntimeCorrectnessMigrations`（v11-v20.ts:189）、`P15_MIGRATION_BASELINE`→`ProviderRuntimeCorrectnessSchemaBaseline` | ~7 | 撞号源头：migration 15 先占号，phase 计数顺延；重命名后两义分离 |
| P16 | ProviderExtensionArchitecture | docs/design/implementation/P16-provider-extension/01-provider-extension-contracts.md:1 | `P16_MIGRATION_BASELINE`→`ReasoningAttachmentSchemaBaseline`（health.ts:21）；`P16_MIGRATIONS`→见迁移区 16 | ~15 | Gate A 冻结，Gate B 未授权 |
| P17 | ConversationDeliveryRuntime | docs/design/implementation/P17-conversation-delivery-runtime/00-contract-index.md:1 | ⚠ `P17_MIGRATIONS`（v11-v20.ts:316）与 phase P17 无关，见迁移区 17；phase P17 的存储是 migration 21 | ~24（含 17–20 号数组） | 文档已完成闭形；符号侧主要在迁移数组 |

## 2. 迁移区（schema register 1–57；TS 符号前缀 P<n>）

定义出处：`adapters/persistence-sqlite/src/migrations.ts` `CURRENT_MIGRATIONS`
（:65-85）及各 DDL 文件。语义名即迁移 `name` 字段的 PascalCase 形式；无设计
phase 对应的纯迁移号按 DDL/测试反推（owner 裁决②）。`P<n>_MIGRATIONS` 是
"截至迁移 n 的累积前缀数组"，统一改名为 `To<Semantic>Migrations`；
`P<n>_MIGRATION_BASELINE`（ports/src/health.ts:13-51）统一改成
`<Semantic>SchemaBaseline`。

| 编号 | 语义名 | 定义出处 | 现有符号→新名（举要） | 受影响面（文件数估计） | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | InitSchema | migrations/v01-v10.ts:166 | `P1_MIGRATIONS`→`ToInitSchemaMigrations`（:165） | ~13 | |
| 2 | ExecutionSessionKernel | migrations/v01-v10.ts:255 | `P2_MIGRATIONS`/`P2_DDL`→`ToExecutionSessionKernelMigrations` | ~7 | 与 phase P2 同名合法：同概念同术语 |
| 3 | ProviderModelContext | migrations/v01-v10.ts:304 | `P3_MIGRATIONS`/`P3_DDL`→`ToProviderModelContextMigrations` | ~2 | |
| 4 | ToolRuntime | migrations/v01-v10.ts:409 | `P4_MIGRATIONS`/`P4_DDL`→`ToToolRuntimeMigrations` | ~25 | |
| 5 | FormationCommunication | migrations/v01-v10.ts:469 | （由 `P6_MIGRATIONS` 覆盖，:464） | — | migration 5 属 formation/communication DDL |
| 6 | DependencyDeliverable | migrations/v01-v10.ts:544 | `P6_MIGRATIONS`→`ToFormationCommunicationMigrations`（止于 5）；`P7_MIGRATIONS`→`ToDependencyDeliverableMigrations`（:538） | ~19/23 | 数组名按其最后一个迁移命名 |
| 7 | MessagesDeliverKind | migrations/v01-v10.ts:545 | （并入 `ToDependencyDeliverableMigrations`） | — | |
| 8 | Verification | migrations/v01-v10.ts:617 | `P8_MIGRATIONS`/`P8_DDL`→`ToVerificationMigrations`（:609） | ~27 | |
| 9 | EnvironmentChanges | migrations/v01-v10.ts:650 | `P11_MIGRATIONS`→`ToEnvironmentChangesMigrations`（:641） | ~10 | |
| 10 | Worktrees | migrations/v01-v10.ts:681 | `P11B_MIGRATIONS`→`ToWorktreesMigrations`（:671）；`P11B_BASELINE` 同步 | ~10 | |
| 11 | LeaseWorkerIncarnation | migrations/v11-v20.ts:58 | `P12_MIGRATIONS` 前缀数组覆盖（:54） | — | P2 lease hardening 的 DDL，编号借用 P12 数组 |
| 12 | PermissionGrants | migrations/v11-v20.ts:61 | `P12_MIGRATION_BASELINE`→`PermissionGrantsSchemaBaseline` | ~42 | |
| 13 | ProjectToolRegistry | migrations/v11-v20.ts:62 | | ~42 | |
| 14 | HumanMessages | migrations/v11-v20.ts:93 | `P14_MIGRATIONS`→`ToHumanMessagesMigrations`（:91）；`P14_MIGRATION_BASELINE` | ~3 | phase P14 存储 |
| 15 | ProviderRuntimeCorrectness | migrations/v11-v20.ts:193 | `P15_MIGRATIONS`→`ToProviderRuntimeCorrectnessMigrations`（:189） | ~7 | ⚠ 与 phase P15（ProjectManagement）撞号的源头 |
| 16 | ReasoningAttachment | migrations/v11-v20.ts:211 | `P16_MIGRATIONS`→`ToReasoningAttachmentMigrations`（:207） | ~15 | |
| 17 | AgentLoopStepHandoff | migrations/v11-v20.ts:320 | `P17_MIGRATIONS`→`ToAgentLoopStepHandoffMigrations`（:316） | ~24 | ⚠ 与 phase P17 无关；phase P17 存储在 21。DID v1.21 ALS-I1 |
| 18 | ProjectArchiveHumanMessageTerminal | migrations/v11-v20.ts:357 | `P18_MIGRATIONS`→`ToProjectArchiveHumanMessageTerminalMigrations`（:353）；`P18_MIGRATION_BASELINE` | ~24 | 实为 phase P15（Project Management）的 archive 存储 |
| 19 | SessionContextRuntimeConvergence | migrations/v11-v20.ts:419 | `P19_MIGRATIONS`→`ToSessionContextRuntimeConvergenceMigrations`（:415）；`P19_MIGRATION_BASELINE` | ~24 | DID v1.22 SCRC |
| 20 | AgentLoopStepProviderTurnChain | migrations/v11-v20.ts:447 | `P20_MIGRATIONS`→`ToAgentLoopStepProviderTurnChainMigrations`（:443）；`resolveP20OverflowReplacementChain`→`resolveOverflowReplacementChain`（agent-runtime/src/agent-loop-step-recovery.ts:157）；`P20OverflowReplacementChain`→`OverflowReplacementChain` | ~24 | DID v1.23 ordinal-0 ProviderTurn chain |
| 21 | ConversationDeliveryRuntime | migrations/v21-v30.ts:118 | `P21_MIGRATIONS`→`ToConversationDeliveryRuntimeMigrations`（:114）；`P21_MIGRATION_BASELINE`（health.ts:29） | ~12 | phase P17 的 ResponseJob/Attempt 存储（P17 01-domain-storage） |
| 22 | VerificationDeliveryConvergence | migrations/v21-v30.ts:148 | `P22_MIGRATIONS`（:144）；`P22_MIGRATION_BASELINE` | ~6 | verifications summary_ref + 触发器 |
| 23 | VerificationEvidenceIdentity | migrations/v21-v30.ts:167 | `P23_MIGRATIONS`（:163）；`P23_MIGRATION_BASELINE` | ~6 | |
| 24 | ExecutionEpisodeBinding | migrations/v21-v30.ts:234 | `P24_MIGRATIONS`（:230）；`P24_MIGRATION_BASELINE` | ~4 | 纯迁移号，owner②反推：execution↔episode 精确绑定列 |
| 25 | ExecutionEpisodeOnly | migrations/v21-v30.ts:313 | `P25_MIGRATIONS`（:309）；`P25_MIGRATION_BASELINE` | ~4 | 收敛为 episode-only |
| 26 | AgentStateEpisodeOnly | migrations/v21-v30.ts:386 | `P26_MIGRATIONS`（:382）；`P26_MIGRATION_BASELINE` | ~4 | |
| 27 | FormationGovernanceInboxBackfill | migrations/v21-v30.ts:414 | `P27_MIGRATIONS`（:410）；`P27_MIGRATION_BASELINE` | ~4 | 纯迁移号：回填 formation governance inbox 行 |
| 28 | SettledGovernanceInboxCleanup | migrations/v21-v30.ts:439 | `P28_MIGRATIONS`（:435）；`P28_MIGRATION_BASELINE` | ~4 | 纯迁移号：清理已 settle 的 inbox 行 |
| 29 | SubjectBoundPermissionGrants | migrations/v21-v30.ts:469 | `P29_MIGRATIONS`（:465）；`P29_MIGRATION_BASELINE` | ~4 | |
| 30 | ControlActionApprovals | migrations/v21-v30.ts:509 | `P30_MIGRATIONS`（:505）；`P30_MIGRATION_BASELINE`（health.ts:48，deprecated 别名→36） | ~5 | 纯迁移号：CAPA 控制动作审批表 |
| 31 | FormationFulfillment | migrations/v31-v39-and-v41.ts:49 | `P31_MIGRATIONS`（:45）；`P31_MIGRATION_BASELINE`（deprecated 别名） | ~4 | |
| 32 | ActionApprovalConvergence | migrations/v31-v39-and-v41.ts:148 | `P32_MIGRATIONS`（:144）；`P32_MIGRATION_BASELINE`（deprecated 别名） | ~4 | |
| 33 | AssignWorkTargetBindings | migrations/v31-v39-and-v41.ts:242 | `P33_MIGRATIONS`（:238）；`P33_MIGRATION_BASELINE` | ~4 | |
| 34 | AttentionProjection | migrations/v31-v39-and-v41.ts:278 | `P34_MIGRATIONS`（:274）；`P34_MIGRATION_BASELINE` | ~4 | p10_attention_* 表族 |
| 35 | WorkspaceResourceActivationIntents | migrations/v31-v39-and-v41.ts:289 | `P35_MIGRATIONS`（:285）；`P35_MIGRATION_BASELINE` | ~4 | F21 activation intent |
| 36 | ToolInvocationAdmission | migrations/v31-v39-and-v41.ts:343 | `P36_MIGRATIONS`（:339）；`P36_MIGRATION_BASELINE` | ~37 | AH7-DG-03；CHECK 值 `P36Backfill` 见例外区 |
| 37 | DeliverReplayAttentionRows | migrations/v31-v39-and-v41.ts:438 | `P37_MIGRATIONS`（:434）；`P37Probe`→`DeliverReplayProbe` | ~37 | AH10 DeliverReplay outbox + Attention 轮询状态 |
| 38 | ExecutableApprovalHandoff | migrations/v31-v39-and-v41.ts:449 | `P38_MIGRATIONS`（:445）；gateway 边界 `P38StopExecutionBefore*`→`StopExecutionBefore*`（application/src/gateway.ts:68）；`P38BrowserDiagnosticContext`→`BrowserDiagnosticContext` | ~66 | EA-DG-01 |
| 39 | ReconciliationAttempts | migrations/v31-v39-and-v41.ts:332 | `P39_RECONCILIATION_MIGRATION`（:330）→`ReconciliationAttemptsMigration`；P39 维护族：`P39MaintenancePort`→`OfflineMaintenancePort`、`P39WriterExclusionLease`/`P39WriterLockClient*`→`WriterExclusionLease`/`WriterLockClient*`（policy 已示例 `DatabaseWriterLock`）、`P39WindowsSecurity*`→`WindowsSecurity*`、`P39PrimarySqlClient`→`PrimarySqlClient`、`P39PreflightSnapshot`→`UpgradePreflightSnapshot`、`P39RecoveryEvidenceStore*`→`ReconciliationRecoveryEvidenceStore*`；文件 p39-*.ts（6 个）→maintenance/reconciliation 语义名 | ~143（P39 全部）；符号族 ~70 | AH7-DG-02。特权 maintenance-only 步骤，不在 CURRENT_MIGRATIONS 内。CHECK 值 `P39Claim`/`P39Admission` 见例外区 |
| 40 | ToolObservationReplayEvidence | migrations/v40-v44-v54-observation-guards.ts:338 | `P40_TOOL_OBSERVATION_REPLAY_MIGRATION`→`TOOL_OBSERVATION_REPLAY_MIGRATION` | ~6 | |
| 41 | SubmittedDecisionBindingAttention | migrations/v31-v39-and-v41.ts:514 | `P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION`（:511）→`SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION` | ~5 | AH10 DID v1.42 |
| 42 | ProjectResourceSourceAttribution | src/p42-project-resource-source-migration.ts:7 | `P42_PROJECT_RESOURCE_SOURCE_MIGRATION`→`PROJECT_RESOURCE_SOURCE_MIGRATION`；文件 p42-*.ts→project-resource-source-migration.ts | ~5 | |
| 43 | BlockedWorkEpisodeAndInboxSequence | src/p43-blocked-workepisode-migration.ts:9；migrations.ts:57-62 | `P43_BLOCKED_WORKEPISODE_MIGRATION`→`BLOCKED_WORK_EPISODE_MIGRATION`；`P43_MIGRATION`→保留 register 聚合语义改 `BLOCKED_WORK_EPISODE_MIGRATION_ENTRY` | ~6 | |
| 44 | ApprovalRejectedNoEffectDenial | migrations/v40-v44-v54-observation-guards.ts:369 | `P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION`→去前缀 | ~5 | |
| 45 | RetryVerificationOrigin | src/p45-retry-verification-origin-migration.ts:8 | `P45_RETRY_VERIFICATION_ORIGIN_MIGRATION`→`RETRY_VERIFICATION_ORIGIN_MIGRATION` | ~5 | 含 unbound legacy inbox 清理 |
| 46 | VerificationEvidenceSnapshot | src/p46-verification-evidence-snapshot-migration.ts:6 | `P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION`→去前缀 | ~5 | |
| 47 | LegacyAdoptionEvidenceAttention | src/p47-ah14-legacy-adoption-attention-migration.ts:6 | `P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION`→`LEGACY_ADOPTION_EVIDENCE_ATTENTION_MIGRATION` | ~5 | AH14 DID v1.49 |
| 48 | ConversationCheckpointOwner | src/p48-ah19-conversation-checkpoint-owner-migration.ts:6 | `P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION`→`CONVERSATION_CHECKPOINT_OWNER_MIGRATION` | ~5 | AH19 DID v1.50 |
| 49 | SandboxPolicyAndGrantProvenance | src/p49-sandbox-policy-and-grant-provenance-migration.ts:11 | `P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION`/`_FINGERPRINT`→去前缀 | ~5 | |
| 50 | SandboxProviderUnavailableFact | src/p50-sandbox-provider-unavailable-fact-migration.ts:11 | `P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION`→去前缀；execution-runtime tag `P50StoreUnavailable`→`StoreUnavailable`（execution-runtime.ts:522） | ~6 | 环境阻塞事实，readmission 消费 |
| 51 | VerificationV2ConsumerReconciliation | src/p51-verification-v2-consumer-reconciliation-migration.ts:93 | `P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION`→去前缀 | ~5 | |
| 52 | WorkContractRevisionHistory | src/p52-work-contract-revision-migration.ts:115 | `P52_WORK_CONTRACT_REVISION_MIGRATION`→去前缀 | ~5 | |
| 53 | CanonicalOwnershipCarveouts | src/p53-canonical-ownership-carveouts-migration.ts:8 | `P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION`→去前缀；文件 p53-*.ts→canonical-ownership-carveouts-migration.ts | ~7 | 纯迁移号，owner②反推：resource_ownership 排除/委托列 + activation intent 委托绑定 |
| 54 | NativeProcessModeNoEffectDenial | migrations/v40-v44-v54-observation-guards.ts:395 | `P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION`→去前缀；裸 describe `"P54 Native process-mode no-effect Denied migration"`→`"native process mode no-effect denial migration"`（adapters/persistence-sqlite/test/p54-*.test.ts:39） | ~7 | 纯迁移号，owner②反推：NativeOsSupportedOnly 下的无效果 Denied 行 |
| 55 | SessionCausalProvenance | migrations.ts:34 | `P55_SESSION_CAUSAL_PROVENANCE_MIGRATION`→去前缀 | ~6 | 纯迁移号：session_entries.causal_binding_json（PP-W401） |
| 56 | LinuxWorkspaceNetworkV2Boundary | migrations.ts:45 | `P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION`→去前缀 | ~6 | 纯迁移号：`SELECT 1;` 只推进 user_version 的兼容边界（DID 1.66 §8.3） |
| 57 | WorkspaceSandboxAuthorization | src/p57-workspace-sandbox-authorization-migration.ts:7 | `P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION`→去前缀；文件 p57-*.ts→workspace-sandbox-authorization-migration.ts | ~10 | 纯迁移号：workspace_sandbox_authorizations 授权修订表（offline-only staged） |

schema 版本号本身（`CURRENT_SCHEMA_VERSION = 57`、user_version 对齐、
upgrade manifest 36–38/44–57 源）是真实版本语义，合法保留（policy 的
version exception）。

## 3. AH 区（crash-window / qualification boundary 编号）

定义出处：AH1–AH19 = `docs/design/implementation/P9/07-agent-loop-step-recovery.md`
:380-398（DID v1.20 状态处置矩阵）；AH56 = 无设计编号，从测试反推（owner 裁决②）。
边界标签命名规则：直接删编号，其余部分已是语义名
（`AH7AfterToolIntentCommit`→`AfterToolIntentCommit`；
`AH19BeforeConversationCheckpointOwnerCommit`→`BeforeConversationCheckpointOwnerCommit`；
`AH56AfterOutputAcceptedCommit`→`AfterOutputAcceptedCommit`）。
标签清单：agent-runtime `qualification-probe.ts:5-47`（31 项）、application
`gateway.ts:48-74`、`input-promotion.ts:58`、tool-runtime `runtime/types.ts:41-53`、
adapters `recovery-binding-store.ts:137`（`P4P39ClaimBeforeCommit`→
`RecoveryBindingClaimBeforeCommit`）。

| 编号 | 语义名 | 定义出处 | 现有符号→新名（举要） | 受影响面（文件数估计） | 备注 |
| --- | --- | --- | --- | --- | --- |
| AH1 | ProviderAttemptSuccess | P9/07:380 | （矩阵行，无独立符号） | — | complete terminal events → ProviderAttempt Success |
| AH2 | ProviderTurnSettlement | P9/07:381 | （矩阵行） | — | ProviderAttempt Success → ProviderTurn settled |
| AH3 | LoopStepAvailability | P9/07:382 | `AH3Before/AfterStepAvailable`→`Before/AfterStepAvailable`（qualification-probe.ts:7-8） | 含于 AH 簇 | ProviderTurn settled → step ProviderResultAvailable |
| AH4 | SettlementProposal | P9/07:383 | `AH4Before/AfterSettlementProposal`、`AH4Repair*`→去前缀（qualification-probe.ts:9-12） | 含于 AH 簇 | 含 repair 窗口 |
| AH5 | SourcedModelOutput | P9/07:384 | 测试名 `model-output-ah5-ah6.functional.test.ts`→`model-output-atomic-commit.functional.test.ts` | ~4 | decode complete → sourced ModelOutput SessionEntry |
| AH6 | OutputAccepted | P9/07:385 | 同上 | ~4 | SessionEntry → step OutputAccepted |
| AH7 | ActionIntentEffectSettlement | P9/07:386；补充矩阵 P9/02:150-166（AH7-AP1…AP8） | tool-runtime 13 个 `AH7*` 边界（runtime/types.ts:41-53）；测试目录 tests/functional/process/ah7/→tests/functional/process/tool-admission-recovery/；`ah7-cross-process-tool-runtime-child.mjs`→`cross-process-tool-runtime-child.mjs` | ~102（AH7 全部） | 最大簇；approval claim/fencing/stop 边界都在此 |
| AH8 | StaleControlBasisBetweenActions | P9/07:387 | （矩阵行；probe stage `P9Action*` 相邻，见 P9 行） | — | action A 提交后、B 之前 ControlBasis 过期 |
| AH9 | TerminalActionSkipRemainder | P9/07:388 | `AH9Before/AfterTerminalActionCommit`→去前缀（qualification-probe.ts:20-21） | 含于 AH 簇 | |
| AH10 | FencedReceiptGenerationTakeover | P9/07:389；Deliver 修订 P9/07:10-16 | `AH10BeforeFencedReceiptCommit`→`BeforeFencedReceiptCommit`（gateway.ts:52）；`AH10*SubmittedDecisionBinding*`→去前缀（execution-runtime） | ~78 | 含 DeliverReplay receipt 恢复（DID v1.37/v1.42/v1.43） |
| AH11 | StepEffectsCommit | P9/07:390 | `AH11Before/AfterStepEffectsCommit`→去前缀 | 含于 AH 簇 | Observation append → StepEffectsCommitted |
| AH12 | SettleExecutionCommand | P9/07:391 | `AH12Before/After*`→去前缀（gateway.ts:54、qualification-probe） | 含于 AH 簇 | SettlementProposed → SettleExecution |
| AH13 | HumanMessageConvergence | P9/07:392 | `AH13Before/AfterResponseSweepCommit`→去前缀（ah-crash-child.mjs） | 含于 AH 簇 | Execution settled → HumanMessage 收敛 |
| AH14 | LegacyAdoptionIdempotence | P9/07:393；证据 Attention 矩阵 P9/02:319 | `AH14Before/AfterLegacyAdoption*`→去前缀（qualification-probe.ts:32-37） | ~23 | DID v1.49 evidence-gated adoption |
| AH15 | InboxAppendConsumeAtomicity | P9/07:394 | `AH15Before/AfterInboxPromotionCommit`→去前缀（application/src/input-promotion.ts:58） | 含于 AH 簇 | Inbox append ↔ consumed |
| AH16 | ToolSettlementResultAtomicity | P9/07:395 | （矩阵行，无独立符号） | — | Tool settlement ↔ sourced ToolResult |
| AH17 | CompactionCheckpointEpoch | P9/07:396 | `AH17Before/AfterCheckpointEpochCommit`→去前缀（qualification-probe.ts:24-25） | 含于 AH 簇 | |
| AH18 | ProviderOverflowTerminalConvergence | P9/07:397 | `AH18Before/AfterOverflowLinksCommit` 等 6 个→去前缀（qualification-probe.ts:26-28） | ~17 | DID v1.23 链；含 summary turn 变体 |
| AH19 | ConversationCheckpointOwnerRecovery | P9/07:398；checkpoint 矩阵 P9/02:341 | `AH19Before/AfterConversationCheckpointOwnerCommit`、`AH19NativeCheckpointRecovery`→去前缀（qualification-probe.ts:29-31）；policy 已示例 `AH19Recovery`→`ProviderBindingRecovery` | ~62 | DID v1.50；phase P14/P17 交界语义 |
| AH56 | OutputAcceptedAtomicCommit | 反推：packages/agent-runtime/src/qualification-probe.ts:13；tests/functional/process/model-output-ah5-ah6.functional.test.ts:26-57；packages/agent-runtime/src/model-output-journal.ts:288-296 | `AH56AfterOutputAcceptedCommit`→`AfterOutputAcceptedCommit` | ~4 | 无设计编号（56 与迁移号撞号）。反推依据：probe 在 sourced ModelOutput SessionEntry + AgentLoopStep OutputAccepted 共享事务提交后触发；测试断言"restarts after the shared commit without appending output or calling Provider twice"——即 AH5/AH6 窗口的 commit 侧崩溃边界 |

## 4. 环境变量区（ARBOR_，带编号的 19 个）

其余 ARBOR_ 变量（DB、authority 根、provider 配置等）不带编号，不在本表。
以下全部为 test/qualification 专用注入变量，与消费它们的测试同批原子重命名，
不构成持久化格式。

| 编号 | 语义名 | 定义出处 | 现有符号→新名（举要） | 受影响面（文件数估计） | 备注 |
| --- | --- | --- | --- | --- | --- |
| AH（通用） | CrashBoundary | tests/functional/support/ah-crash-child.mjs:58 | `ARBOR_AH_BOUNDARY`→`ARBOR_TEST_CRASH_BOUNDARY`（值随第 3 节更名）；`ARBOR_AH_BOUNDARY_SKIP_COUNT`→`ARBOR_TEST_CRASH_BOUNDARY_SKIP_COUNT`（sandbox-v6/drift-phase-fresh-root.ts:45） | ~40 | crash child 按 boundary 名 kill 进程 |
| AH7（进程内） | ToolReconciliationTestControls | tests/functional/process/ah7/drive-to-crash.ts:161-168 | `ARBOR_AH7_TEST_RECONCILIATION_MODE`→`ARBOR_TEST_TOOL_RECONCILIATION_MODE`；`ARBOR_AH7_TEST_CRASH_BOUNDARY`→`ARBOR_TEST_TOOL_CRASH_BOUNDARY`；`ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE`/`ARBOR_AH7_TEST_DRIFT_ON_RECONCILE`→去 AH7 | ~10 | |
| AH7（跨进程） | CrossProcessToolRuntimeControls | adapters/persistence-sqlite/test/fixtures/ah7-cross-process-tool-runtime-child.mjs:29-32 | `ARBOR_AH7_DB`→`ARBOR_TEST_CROSS_PROCESS_DB`；`ARBOR_AH7_EFFECT_LOG`→`ARBOR_TEST_CROSS_PROCESS_EFFECT_LOG`；`ARBOR_AH7_WORKER`→`ARBOR_TEST_CROSS_PROCESS_WORKER`；`ARBOR_AH7_PAUSE_AFTER_EFFECT`→`ARBOR_TEST_PAUSE_AFTER_EFFECT` | ~2 | |
| P39 | AtomicMoveParameters | adapters/persistence-sqlite/src/p39-windows-security.ts:156-160 | `ARBOR_P39_ATOMIC_SOURCE_B64`→`ARBOR_ATOMIC_MOVE_SOURCE_B64`；`ARBOR_P39_ATOMIC_DESTINATION_B64`→`ARBOR_ATOMIC_MOVE_DESTINATION_B64`；`ARBOR_P39_ATOMIC_FLAGS`→`ARBOR_ATOMIC_MOVE_FLAGS` | ~3 | PowerShell 子进程入参；进程内传递，非持久格式 |
| P6 | InboxRebuildTestControls | apps/single-workspace/src/p6-inbox-rebuild.ts:113、:928；apps/single-workspace/test/p6-inbox-rebuild-fixture-child.test.ts:6；apps/single-workspace/test/p6-writer-lock-holder.mjs:12 | `ARBOR_P6_TEST_HOLD_BOUNDARY`→`ARBOR_TEST_INBOX_REBUILD_HOLD_BOUNDARY`；`ARBOR_P6_TEST_CRASH_P39_PHASE`→`ARBOR_TEST_INBOX_REBUILD_CRASH_PHASE`；`ARBOR_P6_FIXTURE_CHILD`/`ARBOR_P6_FIXTURE_RESULT`→`ARBOR_TEST_INBOX_REBUILD_FIXTURE_*`；`ARBOR_P6_LOCK_DIAGNOSTIC`→`ARBOR_TEST_WRITER_LOCK_DIAGNOSTIC`；`ARBOR_P6_TEST_LOCK_BUSY_TIMEOUT_MS`→`ARBOR_TEST_WRITER_LOCK_BUSY_TIMEOUT_MS`（apps/single-workspace/test/p6-inbox-rebuild-process-child.mjs:56） | ~6 | stdout 标记 `P6_REBUILD_TEST_BOUNDARY`/`P6_P39_TEST_CRASH_PHASE`/`P6_REBUILD_FAILED` 同批改为 `INBOX_REBUILD_*`（测试解析，原子改） |

## 5. 测试名区（举要）

规则：删掉编号前缀，保留/补全行为文本（policy "Behavior-named tests"）；文件按
能力重组是 policy 第 4 步，不与本表耦合。基线台账 test-name 类 323 条全部适用。
更多示例见 `scripts/governance/naming-baseline.json`。

| 编号 | 语义名 | 定义出处 | 现有符号→新名（举要） | 受影响面（文件数估计） | 备注 |
| --- | --- | --- | --- | --- | --- |
| P1 | Persistence schema migration | baseline：`describe("P1 DDL migration")` | →`describe("persistence schema migration")` | 323 条台账 | 模式：删前缀 |
| P2 | recovery skeleton / lease-stop-settle matrix | tests/p2-recovery.test.ts:207；tests/p2-recovery-matrix.test.ts:209 | `P2-015 recovery skeleton`→`recovery skeleton`；`P2-016 lease / stop / settle recovery matrix`→去前缀 | 同上 | |
| P6 | formation DDL + stores | tests/p6-ddl.test.ts:65 | `P6-002 DDL + stores`→`formation DDL + stores` | 同上 | |
| P9 | durable timer re-drive | tests/p9-timer-refire.test.ts:148 | `P9-005 durable timer re-drive (fire + clear one tx, D4)`→去 `P9-005` | 同上 | 括号内契约引用合法保留 |
| P10 | attention read-model | tests/p10-attention-readmodel.test.ts:199 | `P10-004 Attention read-model — six sources / severity / target / dedupKey (02 §1)`→删 `P10-004 `；`P10-003`/`P10-007` 同理 | 同上 | |
| P11 | revision algebra | tests/p11-revision-algebra.test.ts:110 | `P11-001 revision algebra (domain)`→删前缀 | 同上 | |
| P17 | agent loop step store | adapters/persistence-sqlite/test/p17-agent-loop-step-store.test.ts:24 | `describe("P17 AgentLoopStep migration")`→`agent loop step handoff migration`；文件 p17-*.test.ts→agent-loop-step-store.test.ts | 同上 | 该 P17 指迁移 17，不是 phase P17 |
| P34 | attention projection migration | baseline | `P34 P10 Attention projection migration`→`attention projection migration` | 同上 | 双编号一条测试名里出现两次，全删 |
| P36 | tool invocation admission migration | baseline：`AH7-DG-03 P36 ToolInvocation state migration` | →`tool invocation admission state migration` | 同上 | |
| P37 | deliver replay outbox | baseline | `P37 DeliverReplay durable outbox`→`deliver replay attention outbox` | 同上 | |
| P38 | executable approval consumption | baseline | `P38 Control approval consumption`→`executable approval consumption` | 同上 | |
| P54 | native process mode no-effect denial | adapters/persistence-sqlite/test/p54-native-process-mode-no-effect-denial-migration.test.ts:39 | 裸 describe `"P54 Native process-mode no-effect Denied migration"`→`native process mode no-effect denial migration`；文件名去 p54- | 同上 | owner②点名项 |
| AH5/AH6 | model output atomic commit | tests/functional/process/model-output-ah5-ah6.functional.test.ts:26 | `AH5/AH6 sourced ModelOutput and OutputAccepted atomic commit`→`sourced ModelOutput and OutputAccepted atomic commit` | 同上 | 含 AH56 反推证据 |

## 6. 数据格式例外（保留不动）

| 字面量 | 位置 | 说明 |
| --- | --- | --- |
| `P36Backfill` / `P39Claim` / `P39Admission` | adapters/persistence-sqlite/src/p39-reconciliation-ddl.ts:119（admission_source CHECK，含 :128/:136 消费） | owner 裁决③：被重放门消费的持久化数据格式，保留不动；仅 TS 侧别名/注释可引用语义名。 |
| `P36LegacyUnprofiled` | adapters/persistence-sqlite/src/p39-reconciliation-ddl.ts:170（fact_origin CHECK） | 映射时发现的同类字面量（同文件同列族），按同一裁决保留；在此补录。 |

按 policy "Compatibility protection" 建议一并登记兼容例外台账（wire/持久值，
重命名即格式变更，需 owner 单独裁决，本表只给语义名不给改名指令）：

- DTO tag `P4NoEffectDenied`（api-contracts/src/views.ts:361、application/src/command-result-codec.ts:106、payload-rules.ts:295）→ 语义名 `NoEffectDenied`。
- authority source tag `P7Coordinator`（application/src/authority.ts:470、dependency-coordinator.ts:221）→ 语义名 `DependencyCoordinator`。
- program family id 值 `"p6-formation" | "p6-communication" | "p6-bootstrap" | "p6-human-steer" | "p8-verification" | "p8-query-inspection"`（agent-runtime/src/prompt-programs.ts:13-20）→ prompt provenance 持久值；类型名改、值待裁决。

## 7. 完成度

- 映射总数：Phase 18 + 迁移 57 + AH 21 + 环境变量 5 组（19 个变量）+ 测试名 13
  例（规则覆盖 323 条台账）。
- TBD-owner：0。全部编号（含 owner 点名的 P53/55/56/57、P21/24/27/28/30、AH56、
  P54 裸 describe）都能从迁移 DDL `name`/SQL、P9/07 矩阵或测试内容反推出唯一
  语义名；唯一在裁决前存疑的 AH56 已由 model-output-journal 提交点 + 功能测试
  断言闭环。
- 执行顺序与验收按 semantic-naming-policy.md 的 ratchet 第 3→8 步；本表是第 3
  步的冻结词表，后续每批重命名以本表为准，发现表错先改表再改码。
