import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const windowsPowerShellModules = (): string =>
  join(
    process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );

/** Set the module path explicitly so child Node and Windows PowerShell
 * processes can load the inbox Microsoft.PowerShell.Security module. */
export const p39WindowsTestEnvironment = (): NodeJS.ProcessEnv => {
  if (process.platform !== "win32") return process.env;
  const environment = {
    ...process.env,
    PSModulePath: windowsPowerShellModules(),
  };
  process.env.PSModulePath = environment.PSModulePath;
  return environment;
};

let windowsAclModuleAvailable: boolean | undefined;

/** Missing PowerShell ACL support means Windows deployment qualification
 * cannot run. Keep ordinary SQL and non-deployment tests enabled. */
export const p39WindowsAclQualificationAvailable = (): boolean => {
  if (process.platform !== "win32") return true;
  if (windowsAclModuleAvailable !== undefined) return windowsAclModuleAvailable;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security; Get-Command Get-Acl | Out-Null",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        env: p39WindowsTestEnvironment(),
      },
    );
    windowsAclModuleAvailable = true;
  } catch {
    windowsAclModuleAvailable = false;
  }
  return windowsAclModuleAvailable;
};

/** Apply an exact private ACL to one test-owned path. The only principals
 * granted access are the current SID, SYSTEM, and Administrators. */
export const setP39PrivateWindowsAcl = (
  path: string,
  kind: "directory" | "file",
): void => {
  if (process.platform !== "win32") {
    if (kind === "directory") chmodSync(path, 0o700);
    else chmodSync(path, 0o600);
    return;
  }
  if (!p39WindowsAclQualificationAvailable()) {
    throw new Error(
      "P39 Windows deployment qualification requires Windows PowerShell Microsoft.PowerShell.Security (Get-Acl).",
    );
  }

  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const securityType =
    kind === "directory"
      ? "[Security.AccessControl.DirectorySecurity]"
      : "[Security.AccessControl.FileSecurity]";
  const inherit =
    kind === "directory"
      ? "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit"
      : "$inherit=[Security.AccessControl.InheritanceFlags]::None";
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    `$acl=${securityType}::new()`,
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
    "$admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
    inherit,
    "$acl.SetAccessRuleProtection($true,$false)",
    "$allow=[Security.AccessControl.AccessControlType]::Allow",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
    "Set-Acl -LiteralPath $p -AclObject $acl",
  ].join(";");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env: p39WindowsTestEnvironment(),
    },
  );
};

export const makeP39PrivateTestDirectory = (
  parent: string,
  prefix: string,
  requireWindowsAcl = true,
): string => {
  const directory = mkdtempSync(join(parent, prefix));
  if (
    process.platform !== "win32" ||
    p39WindowsAclQualificationAvailable() ||
    requireWindowsAcl
  ) {
    setP39PrivateWindowsAcl(directory, "directory");
  }
  return directory;
};

export const createP39PrivateTestFile = (
  filename: string,
  requireWindowsAcl = true,
): void => {
  writeFileSync(filename, "");
  if (
    process.platform !== "win32" ||
    p39WindowsAclQualificationAvailable() ||
    requireWindowsAcl
  ) {
    setP39PrivateWindowsAcl(filename, "file");
  }
};

/** Re-establish owned-path cleanup access before removing a disposable test
 * tree. This keeps test teardown reliable after SQLite creates nested files. */
export const removeP39PrivateTestDirectory = (directory: string): void => {
  if (process.platform === "win32") {
    const currentSid = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        env: p39WindowsTestEnvironment(),
      },
    ).trim();
    execFileSync(
      "icacls.exe",
      [directory, "/grant:r", `*${currentSid}:(OI)(CI)F`, "/T", "/C", "/Q"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
  }
  rmSync(directory, { recursive: true, force: true });
};
