# P12 — 01 Plugin SDK / SPI (G1)

**Authority:** DID v1.14 G1, §10.1/§10.2/§10.4.1, §7.6, §7.7; SD v1.3 §8.2/§8.3; P3 `05` (versioned artifacts); P4 `01`/`03`.
**Status:** DRAFT.

## 1. What a plugin is (frozen)

A plugin is **not** a new package category. The only plugin forms are:

```text
InProcessAdapter   : a package under adapters/* implementing one or more frozen
                     ports (Layer), wired only at the Composition Root
DeclarativePlugin  : registered declarative artifacts (ToolDefinition, Prompt
                     Program, Skill, Provider/Model config) — no code execution
RemoteExtension    : an external process reached through a frozen port over the
                     P12 authenticated versioned transport (`06`), never direct DB
```

No third plugin category; DID §10.1/§10.4.1 is unchanged (`adapters/* → domain, ports`).

## 2. Plugin identity

```ts
PluginId            // plg_ + UUIDv7
PluginVersion       // branded semver string (e.g. "1.4.0")
PluginSdkApiVersion // branded semver string of the SPI contract the plugin targets
```

## 3. SPI surface (versioned, frozen)

The SPI a plugin may bind to is exactly:

```text
ports/*                 (Effect service contracts; §7.7)
api-contracts/*         (outward DTOs; §10.5)
ToolDefinition          (name/version/hash/schema/capability/SideEffectSemantics)
PromptProgram           (programId/revision/hash/family/slots/outputContractRefs)
InstructionFragment     (identity/revision/hash)
SkillRef                (skillId/revision/hash/provenance/disclosureTier)
Provider adapter contract (ProviderPort + CanonicalProviderEvent)
```

## 4. Compatibility policy (frozen mechanism)

```text
PluginSdkApiVersion follows semver.
  MAJOR  : breaking change to any SPI surface above
  MINOR  : additive, backward-compatible SPI surface
  PATCH  : no SPI surface change
Deprecation: an SPI element is deprecated for >= 1 MINOR before removal in a
  MAJOR; deprecated elements remain functional for the whole MINOR window.
A plugin whose declared PluginSdkApiVersion MAJOR != runtime SPI MAJOR is
  rejected at registration with a typed PluginCompatibilityError.
Internal-only artifacts (domain/application internals) are NOT SPI.
```

Only wording iteration and numeric defaults are non-contract (DID §0.1 freeze/closure rules; §13 phase-scoped closure); any SPI slot/authority/composition/binding change is a MAJOR change.

## 5. Project tool explicit registration (G1)

`ToolDefinition.source: "Project"` becomes supported **only** via explicit registration:

```text
RegisterProjectTool (governance Command)
  payload: { pluginId, pluginVersion, definitions: ReadonlyArray<ToolDefinition>, contentHash }
  authority: RegisterProjectToolAuthority (resolver-produced, `02`)
  durable: a project-scoped registration record (P12 contract), scoped by the
           envelope `projectId`, binding
           (pluginId, pluginVersion, contentHash) → ReadonlyArray<ToolDefinition>
```

- **content/version-bound trust**: the registration binds the exact
  `ToolDefinition` content hash + `PluginVersion`; any content/version change requires a new registration.
- **multi-definition registration** (cross-contract completeness correction,
  `01` §5 / `07` §2): one registration may contribute **multiple**
  `ToolDefinition`s; the durable value is the definitions array. The command
  payload carries `definitions: ReadonlyArray<ToolDefinition>` and the handler
  passes the envelope `projectId` to the registry write.
- **project-local 不自动可信**: a project-supplied tool is untrusted until an explicit
  registration is committed; it is never auto-discovered/auto-trusted from the filesystem.
- Registration does **not** change `InvocationAuthority`, capability ceiling, `SandboxPort`,
  or `ResourceBoundary` semantics (P4 G1–G6 unchanged); a registered tool still passes the
  P4 admission pipeline with a resolver-produced `InvocationAuthority`.

### 5.1 Authority variant (RG-09, N-04)

`RegisterProjectToolAuthority` is a `VerifiedCommandAuthority` variant with exact-match
binding on the project (envelope `projectId`) + plugin identity
(`pluginId`/`pluginVersion`/`contentHash`), so the command passes the gateway's
deterministic exact-match check (P1 §2A):

```ts
RegisterProjectToolAuthority = {
  _tag: "RegisterProjectToolAuthority"
  principal; commandId; semanticRequestFingerprint
  projectId: ProjectId
  pluginId: PluginId; pluginVersion: PluginVersion; contentHash: string
}
```

A project-tool registration is **project-scoped**: it has no workspace target, and the
`RegisterProjectTool` payload carries no workspace. The authority therefore binds no
`targetWorkspaceId`/`targetProjectId` (N-04: an exact-match conjunct no payload field can
satisfy is removed, not asserted). The Application exact-matches the authority's
`projectId` against the command's project and its plugin identity against the payload; a
mismatch is `AuthorityDenied` (no authority re-decision). Production of this variant is
owned by `02` §3 (`01` declares the shape; `02` produces it).

### 5.2 Registration surface (RG-08, E-19, R-11, NEW-13)

The durable registration record is exposed by a `ProjectToolRegistry` port:

```ts
type ProjectToolRegistryError =
  | { readonly _tag: "IdempotencyConflict";
      readonly pluginId: PluginId;
      readonly pluginVersion: PluginVersion;
      readonly existingContentHash: string;
      readonly incomingContentHash: string }
  | { readonly _tag: "ProjectToolRegistryFailure";
      readonly cause: unknown };

interface ProjectToolRegistryService {
  register(input: {
    projectId: ProjectId
    pluginId: PluginId
    pluginVersion: PluginVersion
    contentHash: string
    definitions: ReadonlyArray<ToolDefinition>
  }): Effect.Effect<void, ProjectToolRegistryError, TransactionScope>
  lookup(key: {
    projectId: ProjectId
    pluginId: PluginId
    pluginVersion: PluginVersion
    contentHash: string
  }): Effect.Effect<Option.Option<ReadonlyArray<ToolDefinition>>, ProjectToolRegistryError>
  // P12 cross-contract completeness correction (`01` §5.2 / `07` §2):
  // committed-read enumeration seam for the catalog union.
  listRegisteredToolDefinitions(
    projectId: ProjectId,
  ): Effect.Effect<ReadonlyArray<ToolDefinition>, ProjectToolRegistryError>
}
```

- **`listRegisteredToolDefinitions` (cross-contract completeness correction).** Returns the
  `ToolDefinition`s contributed by **committed** registered Project plugins for the project:
  - only committed registrations are returned (pre-commit/unregistered entries are absent
    per the frozen registration lifecycle);
  - one plugin registration may contribute **multiple** `ToolDefinition`s;
  - returned definitions retain their own `ToolDefinitionRef(name, version, hash)`
    identities — the registry identity key `(pluginId, pluginVersion, contentHash)` and the
    tool definition identity `ToolDefinitionRef` are **intentionally distinct** and are not
    unified;
  - it **MUST NOT** require `TransactionScope` (committed-read; normal catalog reads must
    not force Model Context / `prepareTurn` into a persistence transaction).

- **CI-1 (NEW-13):** `register` is a **durable canonical write**. It is invocable **only**
  by the `RegisterProjectTool` handler, inside the `CommandGateway` transaction; no other
  caller (composition root, adapter, plugin) may invoke it. The port therefore carries the
  `TransactionScope` requirement, and `ProjectToolRegistryError` is the handler's typed
  failure (never a silent partial write).
- **Migration:** the registration store is the durable `project_tool_registry` table,
  added by P12 migration `0013_project_tool_registry` (part of the ordered P12 migration
  list, `06` §3 / `00` TR-7). The table is keyed
  `(project_id, plugin_id, plugin_version, content_hash)`; `project_id` is the relational
  scope key (from the envelope), not a new domain field.
- Registration identity is `(pluginId, pluginVersion, contentHash)`, scoped to a project.
- Idempotency: the **same key** is a replay (no-op, same result); the same
  `(projectId, pluginId, pluginVersion)` with a **different `contentHash`** is an
  `IdempotencyConflict` (typed), never a silent overwrite.
- **registered → catalogued → visible**: a registered Project tool becomes catalogued
  only after the registration transaction commits; an **unregistered** tool is absent
  from `visibleRefs`, and `ToolCatalogPort.resolveForModel` on it fails with a typed
  `ToolCatalogError` (never a placeholder).

## 6. Trust model

```text
InProcessAdapter   : trusted at composition (source-reviewed), still authority-gated
DeclarativePlugin  : trusted only after RegisterProjectTool + governance authority
RemoteExtension    : authenticated transport + resolver-produced authority facts
```

## 7. Architecture / DAG

DID §10.4.1 is authoritative: the only allowed adapter edge is `adapters/* → domain, ports`.
The current allow-list is **NOT reconciled** with that rule. Exact facts
(NEW-2 / RG-02 / DF-16):

```text
adapters/environment-resolver-local/src/index.ts  imports fingerprintOf (runtime value)
                                                   from @arbor/application
adapters/sandbox-worktree/src/index.ts            imports type CommandRejection
                                                   from @arbor/application
tests/architecture/package-dag.ts                 ALLOWED_EDGES whitelists
                                                   ["domain","ports","application"] for BOTH
tests/architecture/p11-closure.test.ts:152-165    asserts exactly those edges
```

P12 owns the reconciliation (tracked under G8/DF-16 (`00` G8 row + exit-criterion mapping); not a silent rewrite):

- relocate `fingerprintOf` to **`ports`** (NOT `domain`: it imports `node:crypto` and the
  domain must stay runtime-free — `packages/domain/src/snapshot-identity.ts:126-131`), so
  the adapter imports no
  `@arbor/application`;
- replace the `sandbox-worktree` `type CommandRejection` reference with a `ports`-level
  rejection type (or an adapter-local typed failure), removing the `application` edge;
- narrow `tests/architecture/package-dag.ts` `ALLOWED_EDGES` for both adapters to
  `["domain","ports"]` and remove the stale `verification-runtime` entry (G8 / DF-16);
- amend `tests/architecture/p11-closure.test.ts:152-165` to assert the reconciled
  domain+ports-only edges.

If relocating `fingerprintOf` would change the digest recipe / fingerprint semantics, that
is **not** an implementation choice: record it as a governance item (DID gap) instead of
inventing a new recipe.

- A new adapter/plugin package must be added to `tests/architecture/package-dag.ts`
  `ALLOWED_EDGES` (currently enumerates concrete adapter names); the allowed edge stays
  `adapters/* → domain, ports`.
- No production package may depend on `apps/*`; no new inward edge without DID proof.

## 8. Must Not Decide

- No new package category; no change to DID §10.1/§10.4.1.
- No auto-trust of project/third-party content.
- No change to P4 authority/admission/sandbox semantics.
- No execution of plugin code outside a registered adapter Layer or the authenticated transport.

## 9. Verification

```text
plugin registration binds (pluginId, pluginVersion, contentHash) → ToolDefinition
PluginSdkApiVersion MAJOR mismatch → PluginCompatibilityError (rejected)
unregistered project tool → not visible / not invocable
registered project tool → still authority-gated (no capability amplification)
```
