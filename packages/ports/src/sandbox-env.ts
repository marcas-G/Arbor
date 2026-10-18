/** Sandbox env projection mechanism (P4 `04` §4; P11 `12` §2; P12 `03` §3,
 * P12 `13` §3 NEW-14). Every sandbox adapter projects any spawned process
 * environment onto this minimal allow-list, so ambient secrets — including
 * `secret-env` material resolved from the process environment — can never
 * reach a sandboxed command. */
export const SANDBOX_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "TZ",
];

export const sandboxEnvironment = (
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  return projectSandboxEnvironment(ambient, SANDBOX_ENV_ALLOWLIST);
};

/** Project ambient variables through the exact allow-list bound by a durable
 * SandboxProcessPolicy. Provider adapters call this before process creation. */
export const projectSandboxEnvironment = (
  ambient: NodeJS.ProcessEnv,
  allowlist: ReadonlyArray<string>,
): NodeJS.ProcessEnv => {
  const projected: Record<string, string> = {};
  for (const key of allowlist) {
    const value = ambient[key];
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  return projected;
};
