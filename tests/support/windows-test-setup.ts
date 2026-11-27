import { windowsTestEnvironment } from "./windows-deployment-qualification.js";

// The invocation-wide protected TEMP root is established before Vitest starts
// workers by windows-global-setup.ts. Keep the Windows PowerShell module
// path explicit inside each isolated worker and its child processes.
windowsTestEnvironment();
