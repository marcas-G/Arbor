# Windows T3-D D2 V3 physical contract — manual decision

Date: 2026-10-20. The human/manual governor explicitly accepted
`ACCEPT_WINDOWS_T3D_D2_V3_PHYSICAL_CONTRACT_V1` and granted
`AUTHORIZE_NATIVE_OS_SANDBOX_WINDOWS_OPERATOR_TRUST_V1_IMPLEMENTATION` for the
fixed draft
`planning/proposals/native-os-sandbox-windows-t3d-d2-v3-physical-contract-draft.md`
at commit `9e7ca1e1075f43e417016a9349e6328cfff8955e`, canonical UTF-8 LF
SHA-256
`2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`.
Its independent planning review at
`planning/results/native-os-sandbox-windows-t3d-d2-v3-physical-contract.review.md`
reported B0=0/B1=0/B2=0 for separate-proposal completeness.

Decision scope is the whole fixed physical package: closed V3 bundle,
Windows trust set, HighWaterV3 and sidecar bytes/KAT; protected loader/store
and P1/P4/P10 mapping; V2 migration and fail-closed legacy treatment;
Ed25519 currentness and conservative rejection of every Retiring signature;
and crash/replay gates. The old accepted D2 semantic proposal remains the
parent authority. No alternative key scheme, automatic V2 Windows Supported
carry-forward or historical Retiring acceptance is implied.

The AGENTS.md manual-governance delegation exception permits the exact
accepted design landing in P5 `01`, P12 `13`, P4 `04` and P12 `14`. The
separate implementation token authorizes D2 code **only after** independent
post-landing review reports B0=0/B1=0. D2 may prove signer/production-helper
identity provenance; it may not enable `SandboxProcessPort.run`, publish a
Supported tuple, or claim D4 filesystem, D5 network/Stop or D6 full T3
qualification. The owning-document pre/post byte hashes and landing commit
are recorded in the companion manifest/review.
