# Windows T3-D D2 V3 operator-trust implementation checkpoint

Status: **D2 code boundary implemented and independently reviewed;
operator-positive qualification remains OPEN**. Windows
`windows-restricted-appcontainer-job` and the two probe-only identities remain
`Experimental`, publish empty profiles/network modes, and return
`SandboxProcessPort.run = Unavailable`. No Supported tuple or production helper
launch is claimed. This work is on independent branch
`codex/windows-t3-d2-trust`, based on `dff2e2bd`.

Authority: human tokens
`ACCEPT_WINDOWS_T3D_D2_V3_PHYSICAL_CONTRACT_V1` and
`AUTHORIZE_NATIVE_OS_SANDBOX_WINDOWS_OPERATOR_TRUST_V1_IMPLEMENTATION`, bound
to fixed proposal `planning/proposals/native-os-sandbox-windows-t3d-d2-v3-physical-contract-draft.md`
at `9e7ca1e1`, canonical LF SHA-256
`2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`.
Exact owner-document design landing `d7791a33` and independent post-landing
review `70969f3b` report B0=0/B1=0/B2=0; pre/post Windows-byte hashes are in
`native-os-sandbox-windows-t3d-d2-v3-physical-landing.manifest.md`.

## Implemented and checked

- Exact closed TrustSetV1, detached sidecar, BundleV3 and HighWaterV3 codecs;
  complete canonical-byte and SHA-256 KATs: trust
  `be159a9cfea6d65bf27b6645f94bbe12efa65b7d7ffe513d53477ed48241ea4d`,
  sidecar `b705caabef17937aa3606ea4fbaa14be3e8670bb3c9955337e57cd6817fe6977`,
  bundle `5971402bc958c5f99cd1cdeeca95f364e161821945fb05dc0f8ea642d2399954`,
  high-water `deb5867f939177d2a077c780d245aee91e6d4f8b9b9ba71c7b5a0b364fb2f27e`.
  The separate D1 canonical manifest KAT remains
  `e502199edae3e7b74c9fe6bd9681d727f537585b99d1b5983bbf9b013b4af234`.
- P5 current V2|V3 protected source/high-water dispatch, no malformed-V3 or
  source-first fallback; source drift, rollback, same-revision digest change,
  bad clock, trust digest and unclassified early errors return sanitized
  Unavailable. Early read/JSON failures append a controlled null-identity
  rejection audit. P1/P4/P10 bind the *complete current* V3 bundle
  revision/digest, not a V2 shadow.
- Operator-only V2→V3 source-first/high-water cutover preserves exact V2
  source, high-water and **post-verification/pre-write audit** bytes. V2
  Windows Supported cannot carry: a newer registry must demote it first.
  V3 rotation/revocation advances trust, bundle, registry and surviving
  Windows provider capability revisions even across tuple/version changes;
  Retiring and revoked signatures reject.
- The adapter uses Node Ed25519 over the exact domain-separated canonical
  manifest bytes, with key only from current P5 V3 trust. The first metadata
  read has no authority: a second fixed-path read checks canonical bytes,
  registry evidence digest, sidecar signature and actual source/compiler/PE/
  test-control hashes. Production composition passes a P5 source-bound reader,
  never the D1 test-only injected verifier. The real `capabilities()` boundary
  reads current V3 and the P4 admission helper independently re-reads current
  source/high-water and fixed artifacts; source drift, wrong key, changed
  sidecar and changed PE reject. The provider still never runs a process.

## Verification

Host: Windows `10.0.19044`, Node `24.21.0`. Test trust source identity:
`host:test` (test-only RFC 8032 key, **not** an operator anchor). Three
disposable protected-file crash stages — before V3 source write, after durable
V3 source/before high-water commit, and after durable high-water commit — each
used one killed child and one independent restart-probe child: six real OS
children total, 3/3 tests PASS. Forensic source/high-water/audit content and
content-addressed evidence filenames are asserted after restart. In-memory
audit append race, tuple-change capability-revision bypass, old-source replay,
V2 Supported no-carry and revocation also have negative tests.

- `pnpm lint`: 1334 files PASS at the production-boundary checkpoint.
- `pnpm typecheck`: PASS after the latest production-composition journey.
- `pnpm architecture`: 35/35 files, 192/192 tests PASS after the composition
  assertion update; the targeted Windows architecture file is 2/2 PASS after
  the latest production-factory extraction.
- D2-focused 11-file run: 72/72 PASS, including 3/3 real-process crash tests.
  The later production-factory journey's focused V3 file is 5/5 PASS; adapter/
  P4 related 4-file run is 44/44 PASS. `git diff --check` PASS.
- Full `pnpm check` on the older independent baseline did **not** pass:
  lint/typecheck/architecture and core batches 1–3 passed; core batch 4
  failed P41/P42 tests hard-coded to schema suffix 48 while this baseline has
  49/50, plus an unrelated P47 30-second migration-test timeout. No D2 code
  or design was changed to mask those failures. `pnpm test:package` built but
  F20 clean checkout failed when its schema-48 fixture daemon required offline
  upgrade to schema 50. Final full gates belong on the newer unified
  integration baseline with those fixture fixes.

Independent D2 code review initially reported B0=0/B1=3/B2=1; two forensic/
rotation B1s were fixed at `e782fe0f`. After production probe/P4 wiring and
the architecture assertion, independent read-only review at `f766501a` and
`118961ee` reported **B0=0/B1=0**. The former B2 “two helper calls rather than
real capability probe” is closed by the exact production-factory
`capabilities()` → source drift → P4 fresh rejection journey.

Remaining B2 is an **external positive operator qualification**, not an
implemented Supported gate: the fixed production
`WindowsSandboxProcessHost.cs`, shipped PE, detached non-test operator
signature and complete operator manifest/control artifacts are not provisioned
in this branch. The real fixed-path capability probe therefore cannot produce
positive `ManifestVerified`, and no full positive materializer/effect-admission
journey or current signed PE identity is claimed. D4 filesystem/handle and D5
Disabled network qualifications, D6 Stop/lifecycle and Restricted/Enabled
broker remain independent gates. No V2 unsigned row is promoted.

Windows-byte SHA-256 of representative implementation sources at this
checkpoint: `operator-provenance.ts`
`9A53FEFCBDDF3E8E03B007AB8B3C41315B47BAA661773F2109A5518849354BE5`,
`operator-qualification.ts`
`4FC34716138BA94639690AF829D6DD9A75EABAE74BBEDB469645F0250786317E`,
`sandbox-authority-bundle-v3.ts`
`FA92248563141D6ED7F400C730F85556E97B3CFFE948561073340B8431564882`,
`sandbox-authority-v2-v3-provisioning.ts`
`2A02421F66B7F295602306B2F6CF230C895AA5F10A3F271BC10CEB6972CB5700`,
and `sandbox-authority-v3-rotation.ts`
`B14E502EB2EDFD9AA7907EBB45D66D20C067B4DBDA60F92FD876EB1BDCD12A16`.
These source hashes are audit aids, **not** a shipped-helper binary attestation.

Implementation commits in order:
`a43d01ad`, `7986626b`, `5980e4c2`, `b0f942d4`, `9ab13174`,
`d9dcd6fa`, `eae6f149`, `d6b4f124`, `3ea0cc28`, `e782fe0f`,
`473fdf99`, `f766501a`, `118961ee`.
