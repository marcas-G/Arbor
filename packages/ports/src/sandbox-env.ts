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
  const projected: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = ambient[key];
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  return projected;
};
