# Linux command environment qualification and first installation

This is an incremental checkpoint toward the full Linux coding-agent goal.
It does not complete release, database-version alignment, a real-model command
journey or two concurrent Workspace acceptance. No design files or preserved
user databases were changed in this increment.

## Behavior

The installed launcher now provides `check-environment` and
`install-environment`. The former writes evidence without enabling execution.
The latter runs the same real checks itself, verifies their canonical manifest
and content-addressed result files, stages the complete protected source,
high-water and evidence, and probes the staged source using production code.
Only a supported staged capability can be published by a same-volume directory
rename. It does not grant any project file permission or action approval.

Installation is offline from the daemon and cannot accept a caller-supplied
Supported row, qualification report or weaker verifier. Its fixed per-user
location is the existing `defaultSandboxAuthorityPaths()` location under XDG
data home. A pre-existing authority directory is preserved. `proper-lockfile`
serializes installers and recovers abandoned locks after its 30-second stale
interval. Files are written create-only with 0600 mode and fsync; the staged
root and evidence directory use 0700. The production protected-file adapter
rechecks the source before publication. An unsupported local filesystem or
unsafe parent is rejected before the expensive controls start.

The 22 controls cover file permissions, outside paths, ambient secrets, shared
readonly mounts, host pathname sockets, host loopback, internal TCP, namespace
escape, direct TCP/UDP, public HTTPS, private and mixed DNS answers, rebinding,
process/output/memory/CPU limits, cancellation and timeout of descendant trees.
Mixed-answer and rebinding checks run real DNS packets through a local UDP
authority and the production Node resolver and real TCP connection path. No
fake Supported capability or simulated successful TCP connection is used.

Three fixed sandbox Node control programs remain in the hash-bound native
adapter. The architecture scanner permits only their exact pinned data
literals there; host native imports, changed literals and the same literals in
other production modules remain rejected. This adds no host process-spawn
site. The checker itself lives in the app transport layer.

## Failures that drove changes

1. The initial checker used UUID v4 and a wrong Work prefix. It now uses the
   existing domain UUID v7 generator and `ID_PREFIXES`.
2. The first actual package run completed 20/22 controls. MemoryMax alone
   allowed swap growth rather than prompt exhaustion: its running service had
   about 1 GiB resident memory and 3.5 GiB swap. The exact service was manually
   stopped, so that memory control correctly remained FAIL. Production now
   sets `MemorySwapMax=0` and `OOMPolicy=kill` for the full cgroup.
3. The CPU control actually stopped after about 60 seconds, but its assertion
   rejected the supervisor shell's valid `137/n/a` exit status. The check now
   accepts the exact signal/wrapper spellings while retaining elapsed-time,
   nonzero exit and non-timeout assertions.
4. The next extracted package passed all 22 controls, then failed to install
   with ProtectedRootInvalid because its diagnostic XDG home was on tmpfs.
   This did not install source/high-water or issue production support. The
   supported local-filesystem preflight was subsequently moved earlier, and
   the final installation was then qualified on a separate ext4 directory.

The first failed report is
`.test-results/linux-environment-checks-fixed-20261116/isolated-user-data/environment-checks/linux-check-2TNbT8/result.json`.
The 22/22 candidate followed by tmpfs installation rejection is
`.test-results/linux-environment-install-20261116/isolated-user-data/environment-checks/linux-check-oiAKIs/result.json`.
These failures are retained, not overwritten or counted as successful installs.

## Current validation scope

- Production and root test TypeScript builds passed.
- Architecture: 38 files / 199 checks passed, including native-spawn/data
  literal restrictions and the new memory/swap supervisor settings.
- Native POSIX policy/execution suite: 46/46 with actual native tests enabled.
- First-install guards: 4/4, covering existing source preservation, concurrent
  lock preservation, abandoned-lock recovery and symlink preservation.
- Launcher/build identity tests: 4/4. Changed-file Biome passed.
- Full functional and browser suites have not been rerun for this increment.

The latest candidate is
`.test-results/linux-environment-install-durable-20261116/arbor-0.0.0-preview-01a280f2e9ef-7166d262-linux-x64.tar.gz`,
SHA-256 `081f8c47b770b6c5135cbc7946afcc708f803a926e1c8bd5c8f7c966587e688a`,
buildId `sha256:01a280f2e9efdad439f85f71125426310ef118af8362d505f55348fbc1d28901`.
`releaseQualified` remains false. Its extraction and ordinary
`bin/arbor install-environment` invocation are recorded in the same directory.

## Final installed result

The latest package's ordinary `bin/arbor install-environment` completed with
exit 0 in the independent ext4 XDG directory recorded by
`.test-results/linux-environment-install-durable-20261116/installation-invocation.json`.
All 22 controls passed. The installed manifest is
`blob:sha256:1cea425c4584b8dc4953b4b5784fef2d178af3c7362fc5a7d17392390116e1f5`.
The registry contains exactly one independently qualified
`WorkspaceWrite × Enabled` tuple; other tuples are not inferred.

The final report is
`.test-results/linux-environment-install-durable-20261116/isolated-user-data/environment-checks/linux-check-R50auO/result.json`.
That checker report intentionally retains `installed:false`; the installation
operation publishes separately after checking it. Actual publication, source /
high-water matching, every manifest evidence hash, 0700/0600 modes and single
file-link counts were checked in
`.test-results/linux-environment-install-durable-20261116/installed-verification.json`.
The 18 supervisor units recorded by the controls were inactive or failed with
no remaining cgroup processes. A repeated install exited 1 and preserved every
installed file byte-for-byte.

The same package's ordinary `bin/arbor doctor` exited 0 and printed
`✓ Linux 隔离执行环境检查通过`; its model message explicitly says the detected
credentials have not had their network connection verified. No model call or
browser task was used in this environment qualification, and no model secrets
were copied or changed. The doctor output is retained beside the verification.

This is now an actual first-install/capability result, rather than just a
low-level bwrap plan success. It still does not establish the full coding-agent
goal: schema 55 must advance as DID 8.3 requires, startup/setup must make the
qualified mode reachable for ordinary installs, and the final real-model
command/build/test/recovery and two-Workspace browser journeys remain open.
Service registration/reuse and preview still require their own exact contract.

