import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS = 30_000;
export const P39_WINDOWS_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const atomicMoveCompleteMarker = "P39_ATOMIC_WRITE_THROUGH_MOVE_OK";
const atomicMoveScript = [
  "$ErrorActionPreference='Stop'",
  "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARBOR_P39_ATOMIC_SOURCE_B64))",
  "$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARBOR_P39_ATOMIC_DESTINATION_B64))",
  "$f=[uint32]$env:ARBOR_P39_ATOMIC_FLAGS",
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class P39AtomicMove { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string destination, uint flags); }'",
  "if(![P39AtomicMove]::MoveFileEx($s,$d,$f)){throw 'P39 atomic write-through move failed'}",
  `Write-Output '${atomicMoveCompleteMarker}'`,
].join(";");

export interface P39WindowsSecurityQueryOptions {
  readonly encoding: "utf8";
  readonly timeout: number;
  readonly windowsHide: true;
}

export type P39WindowsSecurityQueryExecutor = (
  command: string,
  args: ReadonlyArray<string>,
  options: P39WindowsSecurityQueryOptions,
) => string;

export interface P39WindowsProtectedPath {
  readonly path: string;
  readonly kind: "directory" | "file";
}

const executeProcess: P39WindowsSecurityQueryExecutor = (
  command,
  args,
  options,
) => {
  if (
    process.platform === "win32" &&
    (command !== P39_WINDOWS_POWERSHELL_EXECUTABLE ||
      !isP39WindowsPowerShellExecutableAvailable())
  ) {
    throw new Error("P39 inbox Windows PowerShell is unavailable or unsafe");
  }
  const environment = { ...process.env };
  if (process.platform === "win32") {
    // Keep module discovery under the same fixed inbox installation; do not
    // derive executable or module paths from mutable environment variables.
    environment.PSModulePath = join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
  }
  return execFileSync(command, [...args], { ...options, env: environment });
};

export interface P39WindowsExecutablePathOperations {
  readonly lstat: (path: string) => {
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
  };
  readonly realpath: (path: string) => string;
}

/** Validate the fixed inbox executable and every parent component. Windows
 * environment variables and PATH are deliberately not consulted. The
 * injectable filesystem seam makes missing/reparse cases testable. */
export const isP39WindowsPowerShellPathSafe = (
  operations: P39WindowsExecutablePathOperations = {
    lstat: lstatSync,
    realpath: realpathSync.native,
  },
): boolean => {
  const components = [
    "C:\\",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\WindowsPowerShell",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    P39_WINDOWS_POWERSHELL_EXECUTABLE,
  ];
  try {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (component === undefined) return false;
      const stat = operations.lstat(component);
      if (stat.isSymbolicLink()) return false;
      if (
        index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()
      ) {
        return false;
      }
    }
    return (
      operations.realpath(P39_WINDOWS_POWERSHELL_EXECUTABLE).toLowerCase() ===
      P39_WINDOWS_POWERSHELL_EXECUTABLE.toLowerCase()
    );
  } catch {
    return false;
  }
};

/** Validate the fixed inbox executable on Windows; other platforms do not
 * claim to provide the Windows security probe. */
export const isP39WindowsPowerShellExecutableAvailable = (): boolean =>
  process.platform === "win32" && isP39WindowsPowerShellPathSafe();

/** Run a bounded Windows P39 owner/ACL/filesystem probe. Errors (including
 * timeout) intentionally propagate so callers can fail closed. The injectable
 * executor keeps the timeout boundary testable without sleeping for 30s. */
export const executeP39WindowsSecurityQuery = (
  script: string,
  executor: P39WindowsSecurityQueryExecutor = executeProcess,
): string =>
  executor(
    P39_WINDOWS_POWERSHELL_EXECUTABLE,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
      windowsHide: true,
    },
  ).trim();

/** Fixed Win32 atomic replacement primitive for protected operator source and
 * high-water files. Paths/flags are data in dedicated environment values;
 * the PowerShell script is a fixed literal, never caller-authored text. Flag 8
 * is WRITE_THROUGH for create-only moves; flag 9 adds REPLACE_EXISTING. */
export const moveP39ProtectedFileAtomically = (
  sourcePath: string,
  destinationPath: string,
  replaceExisting: boolean,
): boolean => {
  if (process.platform !== "win32") return false;
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (dirname(source).toLowerCase() !== dirname(destination).toLowerCase())
    return false;
  if (!isP39WindowsPowerShellExecutableAvailable()) return false;
  const environment = {
    ...process.env,
    PSModulePath: join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
    ARBOR_P39_ATOMIC_SOURCE_B64: Buffer.from(source, "utf8").toString("base64"),
    ARBOR_P39_ATOMIC_DESTINATION_B64: Buffer.from(destination, "utf8").toString(
      "base64",
    ),
    ARBOR_P39_ATOMIC_FLAGS: replaceExisting ? "9" : "8",
  };
  try {
    const output = execFileSync(
      P39_WINDOWS_POWERSHELL_EXECUTABLE,
      ["-NoProfile", "-NonInteractive", "-Command", atomicMoveScript],
      {
        encoding: "utf8",
        timeout: P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
        windowsHide: true,
        env: environment,
      },
    );
    return output.trim() === atomicMoveCompleteMarker;
  } catch {
    return false;
  }
};

const protectedPathsSuccess = "P39_PROTECTED_PATHS_OK";

export const p39WindowsProtectedPathsScript = (
  paths: ReadonlyArray<P39WindowsProtectedPath>,
): string => {
  const encodedPaths = paths
    .map(
      ({ path, kind }) =>
        `@{Path='${Buffer.from(path, "utf8").toString("base64")}';Kind='${kind}'}`,
    )
    .join(",");
  return [
    "$ErrorActionPreference='Stop'",
    `$items=@(${encodedPaths})`,
    "$w=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "$u=$w.User.Value",
    "$t=@($u,'S-1-5-18','S-1-5-32-544')",
    "$m=[int][Security.AccessControl.FileSystemRights]::WriteData -bor [int][Security.AccessControl.FileSystemRights]::AppendData -bor [int][Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [int][Security.AccessControl.FileSystemRights]::WriteAttributes -bor [int][Security.AccessControl.FileSystemRights]::Delete -bor [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][Security.AccessControl.FileSystemRights]::TakeOwnership",
    "foreach($x in $items){",
    "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x.Path))",
    "$r=[IO.Path]::GetPathRoot($p)",
    "if($r.StartsWith(([string][char]92)+([char]92)+'?'+([char]92))){$r=$r.Substring(4)}",
    "$d=[IO.DriveInfo]::new($r)",
    "if(($d.DriveType -ne 'Fixed' -and $d.DriveType -ne 'Removable') -or @('NTFS','ReFS','exFAT','FAT','FAT32') -notcontains $d.DriveFormat){exit 10}",
    "$i=Get-Item -LiteralPath $p -Force",
    "if(($x.Kind -eq 'directory' -and !$i.PSIsContainer) -or ($x.Kind -eq 'file' -and $i.PSIsContainer) -or (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){exit 11}",
    "$a=$i.GetAccessControl()",
    "$g=$false",
    "foreach($q in $a.Access){$sid=$q.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($q.AccessControlType -eq 'Allow' -and (([int]$q.FileSystemRights -band $m) -ne 0)){if(!($t -contains $sid)){exit 12};if($sid -eq $u){$g=$true}}}",
    "$o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value",
    "if(!$g -or $o -ne $u){exit 13}",
    "}",
    `Write-Output '${protectedPathsSuccess}'`,
  ].join(";");
};

/** Validate every supplied Windows path in one bounded PowerShell process. */
export const validateP39WindowsProtectedPaths = (
  paths: ReadonlyArray<P39WindowsProtectedPath>,
  executor: P39WindowsSecurityQueryExecutor = executeProcess,
): boolean => {
  if (paths.length === 0) return false;
  try {
    return (
      executeP39WindowsSecurityQuery(
        p39WindowsProtectedPathsScript(paths),
        executor,
      ) === protectedPathsSuccess
    );
  } catch {
    return false;
  }
};
