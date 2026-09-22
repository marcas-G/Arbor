# P12 — 03 SecretStorePort / SecretRef (G2)

**Authority:** DID v1.14 G2, §7.9, §7.2 (port catalog); P3 `01` §9; SD §8A (information trust).
**Status:** DRAFT.

## 1. Types (frozen, opaque)

```ts
SecretRef      // opaque reference stored in policy/binding/environment refs (never material)
SecretMaterial // opaque resolved credential; never persisted, never logged
```

- `SecretRef` is the only secret-related value allowed in Project Policy,
  `ResponsibilityBoundAgentBinding` / `ExecutionBoundAgentBinding`, or `EnvironmentRef`.
- `SecretMaterial` is produced only at the execution boundary and consumed immediately.

## 2. Port + typed failures

```ts
interface SecretStorePortService {
  resolve(secretRef: SecretRef): Effect.Effect<SecretMaterial, SecretStoreError>
}
SecretStoreError =
  | { _tag: "SecretNotFound"; secretRef: SecretRef }
  | { _tag: "SecretInaccessible"; secretRef: SecretRef; reason: string }
  | { _tag: "SecretExpired"; secretRef: SecretRef }
```

- `resolve` **must** carry a typed failure channel; missing/inaccessible/expired secrets
  must not be silently substituted (the current `E = never` signature is corrected here).
- The port signature changes from raw `string` to `SecretRef` → `SecretMaterial`.

## 3. Adapter (P12)

```text
secret-env  (env-var backed, default)   |   secret-file (restricted path)
```

- Adapter selection is Composition-Root config; adapters live under `adapters/*`.
- Provider/Tool Runtime resolve at the execution boundary; Agent never sees raw secret.
- **Every sandbox adapter MUST project an env allow-list** so `secret-env` material cannot
  leak into the sandbox process environment (see `adapters/sandbox-local`'s existing
  allow-list); cross-referenced in `13` §3.

## 4. No-leak invariant (frozen)

The invariant is over **ALL durable or observable surfaces** (DID §7.9 "任何 durable 或可观测面"),
not a fixed list. The enumeration is illustrative; any new durable store or observable channel is
in scope by default.

```text
SecretMaterial MUST NOT appear in ANY durable or observable surface, including:
  prompt / ModelContext fragment / ProviderTurn request (beyond transport auth)
  session_entries
  domain_events
  logs / traces / metrics
  artifacts / blobs
  durable canonical stores:
    commands / command receipts
    provider_turns / provider_attempts
    tool_invocations
    model_context_manifests
    messages
    memories
    checkpoints
Violation = invariant breach (CI-2).
```

- `SecretRef` may appear where a reference is needed; `SecretMaterial` never.
- Error messages / observations must not embed material.

## 5. Must Not Decide

- No secret semantics change beyond `SecretRef`/`SecretMaterial` + typed failures.
- No storage of material in canonical state; no plaintext in policy/binding/environment.

## 6. Verification

```text
resolve(missing) → SecretNotFound (no silent fallback)
driver no longer hardcodes secretRef:"secret"

sentinel no-leak test (E-20), end-to-end:
  inject SENTINEL_SECRET_<uuid> through the adapter; run one end-to-end turn;
  assert the sentinel is absent from EVERY SQLite table row (scan all tables,
  not a fixed list) and from captured stdout/stderr;
  assert JSON.stringify of the SecretMaterial brand redacts by default
```
