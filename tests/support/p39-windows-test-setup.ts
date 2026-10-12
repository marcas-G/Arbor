import { p39WindowsTestEnvironment } from "./p39-windows-deployment-test.js";

// Every test child process, including P39's fail-closed PowerShell probes,
// inherits the inbox Windows PowerShell modules explicitly.
p39WindowsTestEnvironment();
