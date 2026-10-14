export function buildProcessSpec({
  platform,
  executable,
  prefixArgs = [],
  args,
  cwd,
  env,
}) {
  return {
    executable,
    args: [...prefixArgs, ...args],
    options: {
      cwd,
      env,
      shell: false,
      windowsHide: platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}
