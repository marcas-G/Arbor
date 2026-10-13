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
