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

Every effectful `AgentDirective` carries `decisionBasisManifestId`; a stale
relevant control basis yields `DecisionStale` (`06` §4).

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
  readonly reason: "ContextUnsatisfiable" | "BudgetPressure";
}
interface CompactionResult {
  readonly checkpoint: { readonly ref: string; readonly summaryRef: string };
  readonly newEpoch: ContextEpochNumber;
}
```

- Compaction is a ProviderTurn type (DID §9.10), never an invisible hack.
- `prepareTurn` returns `NeedsCompaction`; the AgentRuntime runs a compaction
  turn and then re-invokes `prepareTurn`.
- Output validation: the compaction turn must produce a valid checkpoint
  reference + summary; otherwise it is a `ModelOutputContractViolation`
  (`06` §3).
- Persistence: P2 `SessionRepository.appendEntry` (`CheckpointReference`) +
  epoch increment; numeric thresholds are empirical.

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
