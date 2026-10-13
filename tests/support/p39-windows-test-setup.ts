import { afterAll } from "vitest";
import {
  createP39PrivateTestTempRoot,
  p39WindowsTestEnvironment,
  removeP39PrivateTestTempRoot,
} from "./p39-windows-deployment-test.js";

const environmentKeys = ["TEMP", "TMP", "TMPDIR", "PSModulePath"] as const;
const previousEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);
const privateTempRoot = createP39PrivateTestTempRoot();

if (privateTempRoot !== null) {
  process.env.TEMP = privateTempRoot.path;
  process.env.TMP = privateTempRoot.path;
  process.env.TMPDIR = privateTempRoot.path;
}

// Every test child process, including P39's fail-closed PowerShell probes,
// inherits the inbox Windows PowerShell modules and this test file's private
// temp root explicitly.
p39WindowsTestEnvironment();

afterAll(() => {
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
});
