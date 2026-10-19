# Windows native sandbox T3-C implementation checkpoint

Baseline: `5b0b4c024daadc96938bcbce8087c09eb46282b1`.
Authority: Windows T3-C user delegation, 2026-10-19. This plan is an
implementation artifact; `docs/design/**` remains frozen.

## Fixed scope

1. Move the native P/Invoke bridge source under the Windows adapter, with a
   pinned source SHA-256 and explicit compiler, build-output, and operator
   qualification binding types. Candidate inspection is read-only and may
   report missing/mismatched evidence. It cannot compile or launch from the
   production adapter. The existing test child remains test-owned.
2. Add a handle-based root inspector to the fixed native source. It must open
   and hold each component with no delete sharing, read final paths and file
   identities from handles, reject reparse points and multi-link files, and
   fail closed on Win32/query errors. Test normal, junction, hard-link,
   outside-root, and concurrent replacement cases in disposable fixtures.
3. Preserve the test bridge's exact UTF-16 environment projection, two-handle
   inheritance list, Job Object readback/limits, and finally cleanup. Add
   negative tests for evidence mismatches and confirm all three production
   provider identities stay Experimental with empty tuples and typed
   Unavailable; no TrustedLocal or process fallback.
4. Record exact observations, source/compiler/binary evidence limits, and
   unresolved controls. Disabled network requires a conclusive direct
   loopback denial in addition to the existing zero-capability and private/
   reserved-public evidence. Named-pipe broker, Restricted/Enabled modes,
   signed helper provenance, and full race-safe effect lifetime remain open.

## Stop condition

Do not connect `SandboxProcessPort.run` to the helper, advertise a Supported
tuple, or issue T3 operator evidence if any required filesystem/network/
artifact control remains unproved. Preserve typed Unavailable and the exact
Experimental/empty capability rows.
