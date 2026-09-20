# P3 — 05 Prompt / Context Contracts

**Authority:** DID v1.7 §8.4, §8.4A, §8.5, §8.6, §8.10, §8.19; DID §0.3
(Prompt/Context change is behavior code); C5.
**Status:** DRAFT (first draft for contract review).

## 1. Prompt Program artifacts are contract artifacts (C5)

A Prompt Program is **not** implementation choice. The Programs P3 actually
uses are **versioned phase-scoped contract artifacts** with provenance and
regression eval:

```ts
type PromptProgramFamily =
  | "BaseAgentProtocol" | "ResponsibilityBoundProtocol"
  | "ExecutionBoundProtocol" | "WorkExecutionProgram"
  | "ResponsibilityFormationProgram" | "CommunicationProgram"
  | "CognitiveModeProgram" | "SkillProgram" | "VerificationProgram"
  | "BootstrapHandoffProgram" | "ContinuationProgram"
  | "CompactionProgram" | "HumanInteractionProgram" | "QueryProgram";

interface PromptProgram {
  readonly programId: string;          // e.g. "base-agent-protocol"
  readonly revision: number;
  readonly hash: string;
  readonly family: PromptProgramFamily;
  readonly slots: ReadonlyArray<PromptSlot>;
  readonly outputContractRefs: ReadonlyArray<string>;
  readonly evalSetRef: string;         // 07 §3
}
```

Rules:

- A change that alters a slot contract, authority role, composition mode,
  output-contract binding, or required/optional slot set is a **contract
  change**: new revision + regression eval.
- Only wording iteration that does not change the contract, and numeric
  defaults, are empirical (DID §13).
- Prompt/Context change is behavior code: version, provenance, regression test
  (DID §0.3, §8.19).

## 2. Programs owned by P3

DID §8.4 lists 14 families; P3 owns the contract artifacts for the programs its
loop uses:

```text
P1  Base Agent Protocol
P2  Responsibility-bound Agent Protocol
P4  Work Execution Program
P12 Compaction Program
```

Other families (Responsibility Formation, Communication, Cognitive Mode,
Skill Selection/Execution, Verification, Bootstrap/Handoff, Continuation,
Human Interaction, Query) are owned by their feature phases (P6/P8/…); P3
freezes only the shared Program/slot/authority/composition contract they use.

## 3. Program structure

```ts
interface PromptSlot {
  readonly slotId: string;
  readonly semanticKind: InstructionSemanticKind;
  readonly authorityRole: AuthorityRole;        // A0..A6 (02 §3)
  readonly strength: "Hard" | "Soft";
  readonly compositionMode: CompositionMode;
  readonly replaceable: boolean;                // ReplaceScope only if true
  readonly required: boolean;
  readonly source: InstructionSource;           // canonical | dynamic surface
  readonly retention: RetentionClass;
  readonly cacheClass: CacheClass;
}
```

- Instruction precedence is by authority/scope/composition, never by prompt
  text order (DID §8.5, §8.6).
- Dynamic surfaces S1–S6 (model-family, permission/sandbox, project/workspace/
  work scoped, tool definitions, environment, user/parent input) feed slots;
  they cannot raise authority above `A0`–`A3`.

## 4. Provenance

- Every fragment/slot carries `InformationTrustMetadata` (`02` §10).
- Runtime-compiled canonical governance/control may be `CanonicalInstruction`;
  retrieved/tool/imported/model-derived content defaults to `DataOnly`.
- Memory promotion preserves provenance and requires an explicit persistence
  policy; model text such as "remember this forever" is not authorization
  (DID §8.4A).

## 5. Model-family compiler

- The compiler turns a `ModelContextPlan` into a `PortableModelRequest`
  (`01` §2) without changing Arbor instruction semantics (DID §7.5).
- It may reorder/format for a model family, but authority/composition
  resolution is already decided; the compiler cannot suppress an `A0`–`A3`
  instruction.
- `compiledRequestHash` is persisted in the Manifest (`02` §6).

## 6. Contract vs empirical

```text
contract change (new revision + eval):
  slot contract, authority role, composition mode, output-contract binding,
  required/optional slot set, trust/provenance semantics

empirical (no contract change):
  wording iteration within a slot, token/cache numeric defaults,
  model-family formatting details
```

## 7. Must Not Decide

- No Program text for families owned by feature phases.
- No eval acceptance criteria for other phases (each phase owns its own).
- No authority ladder changes (DID §8.6).
- No tool surface authorization (P4).
