import { execFileSync } from "node:child_process";

export const P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS = 30_000;

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
) => execFileSync(command, [...args], options);

/** Run a bounded Windows P39 owner/ACL/filesystem probe. Errors (including
 * timeout) intentionally propagate so callers can fail closed. The injectable
 * executor keeps the timeout boundary testable without sleeping for 30s. */
export const executeP39WindowsSecurityQuery = (
  script: string,
  executor: P39WindowsSecurityQueryExecutor = executeProcess,
): string =>
  executor(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS,
      windowsHide: true,
    },
  ).trim();

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
    "$a=Get-Acl -LiteralPath $p",
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
