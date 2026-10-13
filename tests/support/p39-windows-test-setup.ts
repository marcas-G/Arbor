import { p39WindowsTestEnvironment } from "./p39-windows-deployment-test.js";

// The invocation-wide protected TEMP root is established before Vitest starts
// workers by p39-windows-global-setup.ts. Keep the Windows PowerShell module
// path explicit inside each isolated worker and its child processes.
p39WindowsTestEnvironment();
