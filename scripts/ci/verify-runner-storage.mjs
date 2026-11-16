import { realpathSync, statfsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const supportedFileSystems = new Map([
  [0x0000ef53, "ext2/3/4"],
  [0x58465342, "xfs"],
  [0x9123683e, "btrfs"],
  [0xf2f52010, "f2fs"],
  [0x2011bab0, "exfat"],
  [0x00004d44, "fat"],
]);

if (process.platform !== "linux") {
  throw new Error(`Arbor Linux CI requires Linux; got ${process.platform}`);
}

const canonicalWorkspace = realpathSync.native(workspace);
if (canonicalWorkspace !== workspace) {
  throw new Error(
    `GITHUB_WORKSPACE must be a canonical path; got ${workspace} -> ${canonicalWorkspace}`,
  );
}

const workspaceStat = statSync(workspace, { bigint: true });
if (!workspaceStat.isDirectory()) {
  throw new Error(`GITHUB_WORKSPACE is not a directory: ${workspace}`);
}

const currentUid = process.getuid?.();
const mode = Number(workspaceStat.mode & 0o7777n);
if (
  currentUid === undefined ||
  workspaceStat.uid !== BigInt(currentUid) ||
  (mode & 0o022) !== 0 ||
  (mode & 0o100) === 0
) {
  throw new Error(
    `GITHUB_WORKSPACE must be owned and writable only by the runner user: ${workspace}`,
  );
}

const filesystemType = Number(statfsSync(workspace).type);
const filesystemName = supportedFileSystems.get(filesystemType);
if (filesystemName === undefined) {
  throw new Error(
    `Arbor P39 tests require a supported local filesystem; ${workspace} has statfs type 0x${filesystemType.toString(16)}`,
  );
}

console.log(
  JSON.stringify({
    workspace,
    filesystem: filesystemName,
    filesystemType: `0x${filesystemType.toString(16)}`,
    uid: currentUid,
  }),
);
