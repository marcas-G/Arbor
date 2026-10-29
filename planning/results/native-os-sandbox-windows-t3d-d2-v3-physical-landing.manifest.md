# Windows T3-D D2 V3 physical contract — design landing manifest

Status: accepted exact package landing, pending independent post-landing
consistency review. Baseline: `dff2e2bdb41b3108559833fb76dea67363e20d6b`.
Decision:
`planning/results/native-os-sandbox-windows-t3d-d2-v3-physical-acceptance.record.md`.
Accepted draft canonical UTF-8 LF SHA-256:
`2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`.

| Owning document | Accepted physical slice | Pre-landing Windows-byte SHA-256 | Post-landing Windows-byte SHA-256 |
|---|---|---|---|
| `docs/design/implementation/P5/01-composition-root.md` | complete V3 bundle/trust/high-water codec, protected loader/store, V2 migration/high-water and consumer source | `881AA3A96331D5987F13B0FD58703973D09917827C119B99B08ACEE86E129231` | `8386E6B0D6EDEDE3C17A50FBE49E178B6D00C230AC1BE075290BD924A26FBF12` |
| `docs/design/implementation/P12/13-security-performance.md` | Ed25519 sidecar exact codec/message/KAT, signer status/currentness and helper identity | `4F5F0BF15E3CF815BF66599B8F22D8B2A8841B14F2CA1F410E7742D46E41114E` | `DB0A7CA505B7822304974627F8DF8AB35B6D8111ACA384B4BF4168DCAB8E33DE` |
| `docs/design/implementation/P4/04-sandbox.md` | P4 process-policy/ToolRuntime exact current authority mapping and identity-only D2 gate | `2A6EE51B04BA46905528173052416BBE99E6370B430D8F3F79F8FF0C44AAD6F9` | `AD128A290447136866E40FD32B11FEF86DF50B9DAA5778A3876134DA28BC1C37` |
| `docs/design/implementation/P12/14-acceptance.md` | KAT, migration/crash/replay, revocation and admission-drift qualification | `07AF231C6A98467015BA3DBEE46E19688E059CF24BDC5E39A3337CBA43F06CB0` | `343E3F861DDFCE1E43C44125045D0B4C5B69BD661E3F1983D7F63B2609D8DFEA` |

The exact accepted draft supplies the byte preimages and KATs; the landing
places each clause only in its owning document. No top-level DID/SD, earlier
V1/V2 decoder, implementation source, migration or provider status is changed
by the design landing. Git diff and post-landing hashes are the audit image.
