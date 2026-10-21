# P3 — 02 Model Context Contracts

**Authority:** DID v1.7 §6A.10, §8.1–§8.14, §8.19; SD v1.3 §5.5–§5.6.
**Status:** DRAFT (first draft for contract review).

## 1. `prepareTurn()`

```ts
prepareTurn(input: PrepareTurnInput): Effect.Effect<
  TurnPreparation,
  ContextUnsatisfiable | ModelContextError,
  ModelContextRequirements
>;

type TurnPreparation =
  | { readonly _tag: "Ready"; readonly turn: PreparedModelTurn }
  | { readonly _tag: "NeedsCompaction"; readonly request: CompactionRequest }
  | { readonly _tag: "GovernanceBlocked"; readonly issue: GovernanceIssue };
```

- `NeedsCompaction` / `GovernanceBlocked` are legitimate **control results**
  (in `A`); `ContextUnsatisfiable` is typed `E` (DID §6A.10, §8.2).
- `R` contains only `AgentContextSourcePort | KnowledgeQueryPort |
  ModelCapabilityPort | SkillRegistry | ToolCatalogPort | Clock`-class
  services (Context.Service tags) — never SQLite or a provider SDK (DID §7.7).

`PrepareTurnInput` includes `execution`, `agentExecutionState`, `wakeReason`,
`binding`, `responsibility`, `work | mission`, `cognitiveMode`,
`permissionState`, `environmentRef`, `availableSkills`, `toolSurface`.

Provider-neutral `PortableInputItem[]` is an explicit input. Durable Tool and
Control results enter as typed `ToolResult`/`ControlResult` items with stable
`callRef`; they remain DataOnly and their text never becomes an
InstructionFragment. The Manifest records exact durable Session source refs.

Workspace Inbox is not a per-turn context source. At a safe boundary,
`InputPromotionService` atomically appends one source-keyed Session Input and
marks that Inbox entry consumed. The Context Projector only reads promoted
Session Items. Steer promotes at the current loop's next safe sampling
boundary; Queue promotes FIFO after the current drain would otherwise end.

## 2. Agent policy resolution

Deterministic resolution of binding, responsibility, work/mission, cognitive
mode, permission state, environment, available skills and tool surface
(DID §8.2). Produces `AgentPolicySnapshot`; it is a Runtime concern, not an LLM
decision.

## 3. Instruction fragments

```ts
interface InstructionFragment {
  readonly identity: string;
  readonly revision: number;
  readonly hash: string;
  readonly semanticKind: InstructionSemanticKind;
  readonly source: InstructionSource;
  readonly scope: InstructionScope;
  readonly authorityRole: AuthorityRole;      // A0..A6
  readonly strength: "Hard" | "Soft";
  readonly compositionMode: CompositionMode;
  readonly activationCondition: ActivationCondition;
  readonly lifetime: RetentionClass;
  readonly cacheClass: CacheClass;
  readonly budgetClass: BudgetClass;
  readonly modelCompatibility: ReadonlyArray<string>;
  readonly contentRef: ContentRef;
}
```

Authority ladder (DID §8.6): `A0 Runtime Safety > A1 Project > A2 Responsibility
> A3 Work > A4 Execution Strategy > A5 Skill/Mode > A6 Advisory`.
Resolution order: `Authority > Specificity > Composition > Text order`.
Composition modes: `Extend | Specialize | Constrain | ReplaceScope | Advisory`;
`ReplaceScope` requires a slot declaring `replaceable = true`.

## 4. Instruction resolver

```ts
interface ResolvedInstructionSet {
  readonly effective: ReadonlyArray<InstructionFragment>;
  readonly suppressed: ReadonlyArray<InstructionFragment>;
  readonly conflicts: ReadonlyArray<InstructionConflict>;
  readonly governanceIssues: ReadonlyArray<GovernanceIssue>;
}
type InstructionConflict =
  | "AuthorityConflict" | "ScopeConflict" | "GoalConstraintConflict"
  | "CapabilityConflict" | "ReplacementConflict";
```

- Authority/capability resolution is deterministic Runtime; natural-language
  semantic conflict detection may use an LLM but cannot raise authority.
- Unresolvable same-level canonical conflict → `GovernanceBlocked` (DID §8.7,
  §6A.10).

## 5. Context layers, retention, budget

Layers (DID §8.8): `C0 Control`, `C1 Mission/Task`, `C2 Coordination`,
`C3 Cognitive Continuity`, `C4 Evidence/Environment`, `C5 Retrieved Knowledge`,
`C6 On-demand Modules`. `C0`/`C1` are pinned.

Retention classes (DID §8.9): `Pinned | Protected | Compressible | Evictable`.
Eviction order: evict irrelevant optional → shrink retrieved knowledge →
reduce artifact excerpts → compress observations/history → checkpoint/new epoch;
never silently drop hard control facts; if Pinned+Protected cannot fit →
`ContextUnsatisfiable`.

Budget (DID §8.10): `B_ctx = B_model − B_output − B_protocol − B_tools`;
output reserved first. `CacheClass = Stable | SemiStable | TurnDynamic`.

Production budget accounting includes resolved instruction bodies, every
provider input item, executable/control tool definitions and ContextFragments.
Budget evidence priority is provider-reported usage, provider/model estimator,
adapter structured-request estimator, then conservative chars/4 fallback.
Fallback estimation may trigger early compaction but cannot alone classify
ordinary compressible pressure as `ContextUnsatisfiable`.

### AH19 Work pre-checkpoint input frontier (DID v1.50)

Before the first typed `CompactionCheckpoint` for a Work Session, P2 selects
exactly the latest 64 persisted `SessionItem` rows by Session-local sequence.
The current pinned input appears exactly once and canonical C0/C1 Work/control
fragments are independent of these slots. P3 applies the existing
`projectSessionTimeline` branches and filters to this selected window; a
skipped row does not cause an older row to be fetched as a replacement.
`inputFrontier` records the selected
row range considered, not the set of content represented. A skipped row emits
no context item, source ref or checkpoint coverage claim.

On every Provider request, inject the existing hard pinned fragments as
separate identity/revision-bound sources: `WorkObjective`, `WorkConstraints`,
`CompletionExpectation`, `VerificationMissionSummary`,
`ResponsibilityDefinition`, `ResourceBoundary`, effective
Authority/Permission, and every other existing C0/C1 hard fragment. Their
presence is not established by a combined objective-text assertion, and
Session filtering or the 64-row limit cannot evict them.

The selected-row eligible union remains the P2 `SessionItem` set:
`UserMessage`, `AssistantMessage`, `ToolCall`, `ToolResult`, `ControlResult`,
`ContextUpdate`, `CompactionCheckpoint`, and `AttachmentRef`. Existing P3
projection conditions remain unchanged: UserMessage excludes
`source.kind=HumanConversation` and requires string `text`; ToolCall requires
string `callRef`, `toolRef` and `argumentsJson`; ToolResult and ControlResult
require string `callRef`; ContextUpdate uses its normalized projection; only
the latest CompactionCheckpoint is eligible, with Summary `summaryText` or
ProviderNative source/epoch/opaque-ref/binding validation; Observation
fallbacks expose string `payload.observation.text` only for
`entryKind=Observation`. Other types with no existing projector branch remain
unprojected; no fallback representation is introduced.

After a typed Work checkpoint, the active frontier is the exact checkpoint
sequence followed by every unsummarized typed Session entry after it. The
pre-checkpoint 64-row cap does not apply; if this frontier exceeds budget,
return `NeedsCompaction` and use the existing explicit compaction protocol.
Compaction `retainedFrontier` may claim only rows whose content was actually
represented under the existing projector. Older or skipped rows remain
durable and uncovered.

### AH19 Conversation continuity projection (DID v1.50)

Conversation input comes from the separate P14 RootWorkspaceId checkpoint
owner, its covered Answered prefix, ordered durable HumanMessages after that
frontier, and the exact current Claimed message once. P3 does not read Work
Session history/checkpoints for a ConversationResponseEpisode. A current
claimed message stays pinned and uncovered until authoritative Answered
settlement. ProviderNative reuse requires exact complete
ResolvedModelBinding equality; mismatch rebuilds portable Summary from the
retained HumanMessage prefix. This defines projection semantics only and does
not choose the owner-state storage port or physical session binding.

## 6. Plan, prepared turn, manifest

```ts
interface ModelContextPlan {
  readonly instructions: ResolvedInstructionSet;
  readonly context: ReadonlyArray<ContextFragmentRef>;
  readonly tools: ReadonlyArray<ToolDefinitionRef>;
  readonly skills: ReadonlyArray<SkillRef>;
  readonly outputContract: OutputContractRef;
  readonly continuation: ContinuationRef;
}
interface PreparedModelTurn {
  readonly request: PortableModelRequest;      // 01 §2
  readonly manifest: ModelContextManifest;
}
```

`ModelContextManifest` (DID §8.19): providerTurnId, executionId, sessionId +
epoch, modelRef, instruction fragments (revision/hash/source/scope), context
refs, skill refs, tool refs/versions, outputContractRef, budget decision,
compiledRequestHash, and `ControlBasis { projectPolicyRevision,
workspacePolicyRevision, responsibilityRevision, resourceBoundaryRevision,
workId?/workRevision?, authorizationDigest, environmentRevision }`.

`providerTurnId` is the exact DID §2.2.1 ProviderTurnId V2 value. Manifest
creation, ProviderTurn intent, ProviderResult/Attempt evidence, Session source
refs and replay use that same byte-for-byte value. A new Manifest never
normalizes a legacy UUIDv7 source or reconstructs a ProviderTurnId from its
Execution/Step/Session text.

Every effectful invocation is associated by trusted Runtime context with this
Manifest/ControlBasis; the model-authored payload does not carry the binding.
A stale relevant control basis yields `DecisionStale` (`06` §4; DID v1.18
ACR-3/ACR-4). AgentLoopStep replay uses the pinned Manifest and decoder version.

The production ControlBasis resolver reads Project policy, Workspace policy,
Responsibility, ResourceBoundary, optional Work revision, and Environment
revision from canonical repositories. Placeholder revisions or constant
authorization digests are forbidden.

The production Work context assembler emits separate A2/A3 hard fragments for
ResponsibilityDefinition, ResourceBoundary, WorkObjective, WorkConstraints,
CompletionExpectation and VerificationMissionSummary. Combining these facts
into one free-form objective string is forbidden because it loses authority,
revision and scope identity.

## 7. Skills surface (C1)

P3 owns the **Skill surface contract**:

```ts
interface SkillRef {
  readonly skillId: string;
  readonly revision: number;
  readonly hash: string;
  readonly provenance: InformationTrustMetadata;   // §10
  readonly disclosureTier: "Summary" | "Body";
}
interface SkillRegistryService {
  readonly available: (binding: AgentBinding, workspaceId: WorkspaceId)
    => Effect.Effect<ReadonlyArray<SkillRef>, SkillRegistryError>;
  readonly load: (skillId: string, tier: "Summary" | "Body")
    => Effect.Effect<LoadedSkill, SkillRegistryError>;
}
```

- Loading is **progressive disclosure** (DID §8.14): summary first, body on
  demand; a loaded skill never overrides `A0`–`A3` instruction authority.
- Concrete skill content/behavior belongs to the feature phase that owns it
  (P6/P8/…); P3 freezes only surface, loading, provenance and disclosure.

## 8. Cognitive mode

`CognitiveMode` is a named, versioned program selection input (DID §8.12); it
influences instruction composition and context selection but cannot bypass
`A0` safety or `A1`–`A3` governance.

## 9. Compaction ProviderTurn protocol (C2)

P3 owns the **explicit** compaction protocol; P2 keeps Session/Epoch/Checkpoint
persistence.

```ts
interface CompactionRequest {
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly currentEpoch: ContextEpochNumber;
  readonly reason: "BudgetPressure" | "SemanticBoundary" | "ProviderBoundary"
    | "ProviderOverflow";
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly inputFrontier: SessionFrontier;
  readonly bindingFingerprint: string;
  readonly implementationPreference: "Summary" | "ProviderNative" | "Either";
}
type CompactionResult =
  | { readonly _tag: "SummaryCheckpoint"; readonly summaryRef: string;
      readonly retainedFrontier: SessionFrontier;
      readonly newEpoch: ContextEpochNumber }
  | { readonly _tag: "NativeCheckpoint"; readonly opaqueItemRef: string;
      readonly bindingFingerprint: string;
      readonly retainedFrontier: SessionFrontier;
      readonly newEpoch: ContextEpochNumber };
```

- Compaction is a ProviderTurn type (DID §9.10), never an invisible hack.
- `prepareTurn` returns `NeedsCompaction`; the AgentRuntime runs a compaction
  turn, atomically commits checkpoint + next epoch, fresh-reinjects canonical
  control and then re-invokes `prepareTurn` for the same logical step.
- Output validation: the compaction turn must produce a valid checkpoint
  reference + summary; otherwise it is a `ModelOutputContractViolation`
  (`06` §3).
- Persistence: P2 `SessionRepository.commitCompaction` atomically appends the
  typed checkpoint and advances epoch. Started-but-incomplete compaction leaves
  the old epoch active.
- `ProviderNative` checkpoints are usable only with a compatible complete
  ResolvedModelBinding fingerprint; otherwise rebuild through portable Summary.
- Provider overflow permits at most one compact/retry before durable assistant
  output or Tool/Control effect. A second overflow is terminal.
- `ContextUnsatisfiable` is not a compaction reason: it means fixed mandatory
  context cannot fit under the allowed model policy.

## 10. Information trust metadata

```ts
interface InformationTrustMetadata {
  readonly provenanceKind: "CanonicalInternal" | "AuthenticatedHuman"
    | "AuthenticatedAgent" | "ToolObservation" | "ExternalRetrieved"
    | "ImportedArtifact" | "ModelDerived";
  readonly instructionCapability: "CanonicalInstruction"
    | "InstructionCandidate" | "DataOnly";
  readonly epistemicStatus: "Established" | "Supported" | "Unverified"
    | "Conflicting" | "Derived";
}
```

Only Runtime-compiled canonical governance/control may be
`CanonicalInstruction`; retrieved/tool/imported/model-derived text defaults to
`DataOnly` and cannot self-promote authority (DID §8.4A).

## 11. Must Not Decide

- No Prompt Program text (P3 `05`).
- No tool authorization/execution (P4).
- No Session/Epoch/Checkpoint persistence (P2).
- No provider transport (P3 `01`).
- No runnable/dependency reevaluation (P7).
- No Memory persistence policy (later phase).
