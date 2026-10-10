# P12 — 10 Transport Shells (v1.13 G6)

**Authority:** DID v1.14 §10.1/§10.4.1/§10.5 and v1.35 §4.1C, v1.13 G6; SD v1.13 §4.5.1; P10 `01` §1/§4 (Search deferral), P10 `05` §2–§3; P9 `00` (recovery daemon/composition surface); `planning/results/P8.result.md` (consumer-loop daemon wiring); P11 `05` §2 (drift watcher trigger).
**Status:** DRAFT.

## 1. Boundary (frozen)

```text
P10 owns programmatic projection/query + UI-facing view semantics
P12 owns HTTP / WebSocket / CLI / web shell / auth / deployment transport
P12 MUST NOT reinterpret view semantics (transport renders only)
```

Two **disjoint** transport planes (RG-16):

```text
human/parent transport  (this doc) : external humans + parent workspaces
                                     HTTP/WS/CLI/web shell/auth/deployment
remote-worker transport (`06`)     : authenticated + versioned worker⇄control-plane channel
```

The planes share no authority capability and must not be conflated.

## 2. Surfaces

```text
HTTP/WS : bind api-contracts DTOs (views + Problem); forward Commands;
          bind the path-free host resource catalog (FT-DG-01 §9)
CLI     : admin/ops surface (see `04` health, `05` assessment, `06` worker)
web shell: renders api-contracts DTOs
Search  : OUT-OF-v1 deferral (P10 `01` §1/§4) — Search view semantics remain
          P10-owned and UNFROZEN; P12 implements no Search surface. When a frozen
          Search view contract exists, P12 supplies only the transport binding;
          P12 does NOT invent query/index semantics (F9)
deployment: process lifecycle, config, readiness/liveness wiring
daemons : recovery pass driver (`P9/00`), verification/completion consumer loops
          (`P8.result.md`), drift-watcher probe trigger (`P11` `05` §2) (F6)
```

- `api-contracts` is the transport-neutral surface P12 binds to (P10 `05` §3).
- Error presentation uses the frozen `Problem` DTO (DID §10.5).
- **Search (F9) is an explicit out-of-v1 deferral, not an implemented surface.**
  The view semantics are owned upstream of P12 (P10) and are **unfrozen**; P12
  does not implement, wire, or expose a Search surface. If/when P10 freezes a
  Search view contract, P12 supplies only the transport binding (no query/index
  semantics); until then the deferral stands and is **not** a Design Gap
  (`00` F1; `14` §1 item 11 / EC-11).

## 3. Authentication → Authority Resolver

- External human/parent requests are authenticated at the transport boundary.
- Authentication completes before command-body decoding. The HTTP, WebSocket,
  CLI, and future external shells pass the same bounded raw JSON envelope,
  authenticated `Principal`, submission context, and correlation information
  into Application/Composition; they do not cast JSON to
  `ExternalCommandEnvelope` or perform receipt reads.
- Application/Composition applies the single registered strict external
  wire-v1 codec, derives the Handler schema/fingerprint, binds declared Actor
  exactly to the authenticated Principal, and only then calls the P12 Resolver.
  The wire contains no caller-supplied version field. These gates precede
  CommandGateway receipt visibility; the Gateway retains its own in-transaction
  receipt-first replay and final authority check (DID §4.1B; P1 `01` §3,
  `03` §3.1).
- Codec failures use the DID §4.1B non-reflecting `InvalidCommandPayload`
  Problem, mapped to HTTP 400 for malformed/unsupported input. Rejected values,
  unknown property names, raw body fragments, and untrusted exception text are
  not reflected in responses or surfaced diagnostics.
- The authenticated principal + submission context feed the Authority Resolver (`02`),
  which produces the trusted authority fact; transport never asserts authority.
- **Composition root — not the transport — loads `canonicalFacts` / `grants` and invokes
  the resolver** (`02` §2). The transport hands over only the authenticated principal and
  the raw submission context; it holds no resolver capability and cannot synthesize facts.
- External Stop / external `AdmitExecution` follow `02` §4.

## 4. Remote-worker transport is not a human shell (RG-16)

```text
remote worker ⇄ control plane : owned by `06` — authenticated + versioned; worker identity
                                proven, never asserted by payload; no DB credential
human/parent ⇄ shells         : owned here — resolver-gated; no canonical write
```

- This doc owns no worker identity, worker lease, or fencing surface.
- **The authenticated versioned worker⇄control-plane transport is owned by `06`
  (NEW-3).** Its wire contract is declared in `domain`/`ports` terms only
  (`06` §4.1); application authority/rejection types stay control-plane-side in
  `06` §6.1. This doc owns only the human/parent shells.
- A worker never authenticates as a human principal; a human shell never carries worker identity.
- See `06` §3–§5 for the mediated fenced submission; `06` cross-references this doc for the
  human/parent plane rather than duplicating it.

## 5. Deployment deliverables (F6)

```text
production daemon                     : the long-running composition process (P8 `00` defers it)
recovery daemon / composition surface : startup recovery pass driver + periodic/event sweeps
                                        (P9 `00` "Explicitly out of P9")
consumer-loop daemon wiring           : verification + completion chain consumers are
                                        offset-driven; single-command-face preserved
                                        (`P8.result.md` Notes for downstream phases)
drift-watcher trigger                 : probe trigger only; never a truth source (P11 `05` §2)
```

- Daemons submit through `CommandGateway` / Application ports; they never mutate canonical
  state directly (CI-1).
- Daemons are **composition-root wiring** (DID §10.4.1 `apps/*`), not new packages; no new
  internal edge is introduced.

## 6. Invariants

```text
CI-1  transport forwards Commands; it never mutates canonical state directly
no view-semantics reinterpretation (DTOs rendered as-is)
transport never constructs authority facts
no authority capability (canonicalFacts / grants / resolver) in transport
human/parent shells and worker transport stay disjoint (RG-16)
```

## 7. Must Not Decide

- No view semantics (P10), including Search query/index semantics.
- No canonical semantics (DID); no authority decision at the transport layer.
- No worker identity/lease/fencing (owned by `06`); no direct DB access.
- No new daemon packages; daemons are composition-root wiring.

## 8. Verification

```text
HTTP/WS/CLI endpoints bind api-contracts DTOs; Problem for errors
Search: no P12 Search surface (out-of-v1 deferral); P10 view semantics unfrozen;
        if frozen later, P12 binds the transport only — no invented query/index semantics
external request → authenticated principal → resolver fact → CommandGateway
resolver invocation + canonicalFacts/grants loading occur at the composition root, not transport
no transport path writes canonical state directly
human shell carries no worker identity; worker transport carries no human authority
worker transport is owned by `06`; its wire contract is domain/ports-level (no application types)
recovery/consumer daemons run from composition root; offsets drive consumer loops
```

## 9. Host Project Resource Profile catalog (FT-DG-01 functional scope)

P12 host configuration supplies the Profile catalog consumed by the P1
ProjectResourceProfilePort. In the first single-root implementation,
ARBOR_PROJECT_ROOT is the configured directory; host configuration also
supplies the stable opaque resourceProfileRef, ResourceProfileVersion and a
path-free displayName for that entry. At process startup, the composition
adapter validates the directory, resolves its canonical real FileTree
address, and freezes an immutable snapshot for command handling. The same host
configuration must produce the same ref/version across restart; changing
canonical path or scope requires a new configured version. A Profile is not a
capability and does not replace Authority Resolver decisions.

The local web shell exposes an authenticated GET /project-resources catalog
endpoint for the bootstrap form. Its response contains only opaque ref,
version, host-configured friendly display name and availability; the name must
not be derived from the path. It MUST NOT return canonical paths,
environment-variable values, filesystem errors or raw exception text.
The first implementation is limited to the existing local single-user
principal model. A multi-principal host requires a separate catalog visibility
contract before sharing resource entries.

The transport body is:

~~~ts
{
  profiles: ReadonlyArray<{
    resourceProfileRef: string;
    version: string;
    displayName: string;
    available: boolean;
  }>;
  conversationOnlySupported: true;
}
~~~

An empty profile array is valid and still advertises ConversationOnly. This is a
bootstrap catalog, not a Project-scoped P10 View and not an authorization fact.

This route is not a P10 view and does not create a new command. CreateProject
continues through the shared POST /commands path. HTTP, WebSocket and CLI
submissions keep DID v1.34/v1.35 authentication → strict wire-v1 decode →
Actor binding → Resolver → Gateway receipt order. The transport never reads a
receipt or resolves a filesystem path. The immutable Profile adapter's pure
lookup occurs only in the P1 CreateProject handler after the Gateway has
proved no receipt exists.

After Project/Workspace/Session commit, ownership activation reads the
canonical boundary back from the persisted root Workspace and invokes the
existing ownership/environment ports. A path disappearance or canonical
region change fails closed without selecting a replacement Profile. This is
post-commit convergence of the exact CreateProject fact, not a new resource
mutation route.
