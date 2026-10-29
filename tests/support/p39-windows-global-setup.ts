import {
  createP39PrivateTestTempRoot,
  p39WindowsTestEnvironment,
  removeP39PrivateTestTempRoot,
} from "./p39-windows-deployment-test.js";

const environmentKeys = ["TEMP", "TMP", "TMPDIR", "PSModulePath"] as const;

/** Keep one protected temp root for the whole Vitest invocation. Vitest starts
 * an isolated worker per test file; creating and deleting an ACL-protected root
 * in every worker launches hundreds of concurrent icacls processes on Windows
 * and races suite teardown against child processes that still use TEMP. */
export default function p39WindowsGlobalSetup() {
  const previousEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const privateTempRoot = createP39PrivateTestTempRoot();

  if (privateTempRoot !== null) {
    process.env.TEMP = privateTempRoot.path;
    process.env.TMP = privateTempRoot.path;
    process.env.TMPDIR = privateTempRoot.path;
  }
  p39WindowsTestEnvironment();

  return () => {
    try {
      if (privateTempRoot !== null) {
        removeP39PrivateTestTempRoot(privateTempRoot);
      }
    } finally {
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}
