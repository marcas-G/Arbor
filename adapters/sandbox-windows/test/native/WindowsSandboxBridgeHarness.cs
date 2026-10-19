using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class WindowsSandboxBridgeHarness
{
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint DisableMaxPrivilege = 0x0001;
    private const uint LuaToken = 0x0004;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const int ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const uint JobLimitJobTime = 0x00000004;
    private const uint JobLimitActiveProcess = 0x00000008;
    private const uint JobLimitProcessMemory = 0x00000100;
    private const uint JobLimitJobMemory = 0x00000200;
    private const uint JobLimitKillOnJobClose = 0x00002000;
    private const uint CpuRateEnable = 0x00000001;
    private const uint CpuRateHardCap = 0x00000004;
    private const uint SeGroupIntegrity = 0x00000020;
    private const uint FileMapRead = 0x0004;
    private const uint FileMapWrite = 0x0002;

    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenMandatoryLabel
    {
        public SidAndAttributes Label;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public uint Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRateControlInformation
    {
        public uint ControlFlags;
        public uint CpuRate;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributes attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr existingToken, uint flags, uint disabledSidCount, IntPtr disabledSids, uint deletedPrivilegeCount, IntPtr deletedPrivileges, uint restrictedSidCount, IntPtr restrictedSids, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int informationClass, IntPtr information, int informationLength);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DeleteAppContainerProfile(string name);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, IntPtr startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        if (args.Length != 8 || args[0] != "launch")
        {
            Console.Error.WriteLine("invalid test harness arguments");
            return 2;
        }
        try
        {
            string child = Path.GetFullPath(args[1]);
            string mode = args[2];
            uint wallTimeMs = ParseBounded(args[3], 100, 60000, "walltime");
            int stdoutBytes = (int)ParseBounded(args[4], 64, 1048576, "stdout");
            int stderrBytes = (int)ParseBounded(args[5], 64, 1048576, "stderr");
            uint processCount = ParseBounded(args[6], 1, 16, "process-count");
            ulong memoryBytes = ParseBounded64(args[7], 64UL * 1024UL * 1024UL, 1024UL * 1024UL * 1024UL, "memory");
            uint cpuTimeMs = mode == "cpu" ? 500U : 5000U;
            uint closeAfterMs = mode == "tree" ? 1200U : 0U;
            return Launch(child, mode, wallTimeMs, stdoutBytes, stderrBytes, processCount, memoryBytes, cpuTimeMs, closeAfterMs);
        }
        catch (Exception exception)
        {
            Console.WriteLine("HARNESS_ERROR=" + exception.GetType().Name + ":" + exception.Message);
            return 3;
        }
    }

    private static uint ParseBounded(string value, uint min, uint max, string name)
    {
        uint parsed;
        if (!UInt32.TryParse(value, out parsed) || parsed < min || parsed > max)
            throw new ArgumentException("invalid " + name);
        return parsed;
    }

    private static ulong ParseBounded64(string value, ulong min, ulong max, string name)
    {
        ulong parsed;
        if (!UInt64.TryParse(value, out parsed) || parsed < min || parsed > max)
            throw new ArgumentException("invalid " + name);
        return parsed;
    }

    private static int Launch(string child, string mode, uint wallTimeMs, int stdoutLimit, int stderrLimit, uint processLimit, ulong memoryLimit, uint cpuTimeMs, uint closeAfterMs)
    {
        if (!File.Exists(child)) throw new FileNotFoundException("test child missing");
        string profile = "ArborSandboxT3A-" + Guid.NewGuid().ToString("N");
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr baseToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr lowIntegritySid = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeListBuffer = IntPtr.Zero;
        IntPtr capabilityBuffer = IntPtr.Zero;
        IntPtr handleListBuffer = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool profileCreated = false;
        bool rootCompleted = false;
        bool timedOut = false;
        bool outputLimitExceeded = false;
        bool jobClosedByStop = false;
        uint exitCode = UInt32.MaxValue;
        try
        {
            int profileResult = CreateAppContainerProfile(profile, profile, "Arbor test-only sandbox profile", IntPtr.Zero, 0, out appContainerSid);
            if (profileResult != 0) ThrowLastError("CreateAppContainerProfile", profileResult);
            profileCreated = true;

            ApplyTestScratchAcl(Path.GetDirectoryName(child), appContainerSid);

            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault, out baseToken))
                ThrowLastError("OpenProcessToken", Marshal.GetLastWin32Error());
            if (!CreateRestrictedToken(baseToken, DisableMaxPrivilege | LuaToken, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken))
                ThrowLastError("CreateRestrictedToken", Marshal.GetLastWin32Error());
            if (!ConvertStringSidToSid("S-1-16-4096", out lowIntegritySid))
                ThrowLastError("ConvertStringSidToSid", Marshal.GetLastWin32Error());
            TokenMandatoryLabel label = new TokenMandatoryLabel();
            label.Label.Sid = lowIntegritySid;
            label.Label.Attributes = SeGroupIntegrity;
            int labelSize = Marshal.SizeOf(typeof(TokenMandatoryLabel)) + (int)GetLengthSid(lowIntegritySid);
            IntPtr labelBuffer = Marshal.AllocHGlobal(labelSize);
            try
            {
                Marshal.StructureToPtr(label, labelBuffer, false);
                if (!SetTokenInformation(restrictedToken, 25, labelBuffer, labelSize))
                    ThrowLastError("SetTokenInformation(TokenIntegrityLevel)", Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(labelBuffer); }

            SecurityAttributes pipeAttributes = new SecurityAttributes();
            pipeAttributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            pipeAttributes.InheritHandle = true;
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0)) ThrowLastError("CreatePipe(stdout)", Marshal.GetLastWin32Error());
            if (!CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0)) ThrowLastError("CreatePipe(stderr)", Marshal.GetLastWin32Error());
            if (!SetHandleInformation(stdoutRead, HandleFlagInherit, 0) || !SetHandleInformation(stderrRead, HandleFlagInherit, 0))
                ThrowLastError("SetHandleInformation", Marshal.GetLastWin32Error());

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject", Marshal.GetLastWin32Error());
            ConfigureJob(job, processLimit, memoryLimit, cpuTimeMs);

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeListSize);
            attributeListBuffer = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeListBuffer, 2, 0, ref attributeListSize))
                ThrowLastError("InitializeProcThreadAttributeList", Marshal.GetLastWin32Error());
            attributeList = attributeListBuffer;

            SecurityCapabilities capabilities = new SecurityCapabilities();
            capabilities.AppContainerSid = appContainerSid;
            capabilityBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(capabilities, capabilityBuffer, false);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities), capabilityBuffer, new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute(SecurityCapabilities)", Marshal.GetLastWin32Error());

            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stderrWrite);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeHandleList), handleListBuffer, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute(HandleList)", Marshal.GetLastWin32Error());

            environmentBlock = CreateProjectedEnvironmentBlock();

            StartupInfo startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Flags = StartfUseStdHandles;
            startup.StdInput = InvalidHandle;
            startup.StdOutput = stdoutWrite;
            startup.StdError = stderrWrite;
            StartupInfoEx startupEx = new StartupInfoEx();
            startupEx.StartupInfo = startup;
            startupEx.AttributeList = attributeList;
            IntPtr startupBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(StartupInfoEx)));
            Marshal.StructureToPtr(startupEx, startupBuffer, false);
            try
            {
                string commandLine = Quote(child) + " " + Quote(mode);
                StringBuilder mutableCommandLine = new StringBuilder(commandLine);
                if (!CreateProcessAsUser(restrictedToken, child, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent, environmentBlock,
                    Path.GetDirectoryName(child), startupBuffer, out process))
                    ThrowLastError("CreateProcessAsUser", Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(startupBuffer); }

            CloseIfSet(ref stdoutWrite);
            CloseIfSet(ref stderrWrite);
            if (!AssignProcessToJobObject(job, process.Process)) ThrowLastError("AssignProcessToJobObject", Marshal.GetLastWin32Error());
            if (ResumeThread(process.Thread) == UInt32.MaxValue) ThrowLastError("ResumeThread", Marshal.GetLastWin32Error());

            Task<BoundedRead> stdoutTask = Task.Factory.StartNew(() => ReadBounded(stdoutRead, stdoutLimit, job), TaskCreationOptions.LongRunning);
            Task<BoundedRead> stderrTask = Task.Factory.StartNew(() => ReadBounded(stderrRead, stderrLimit, job), TaskCreationOptions.LongRunning);

            if (closeAfterMs > 0)
            {
                Thread.Sleep((int)closeAfterMs);
                CloseIfSet(ref job);
                jobClosedByStop = true;
                rootCompleted = WaitForSingleObject(process.Process, 10000) == 0;
            }
            else
            {
                uint wait = WaitForSingleObject(process.Process, wallTimeMs);
                if (wait == 0x00000102)
                {
                    timedOut = true;
                    TerminateJobObject(job, 0x00000102);
                    rootCompleted = WaitForSingleObject(process.Process, 5000) == 0;
                }
                else rootCompleted = wait == 0;
            }

            if (rootCompleted) GetExitCodeProcess(process.Process, out exitCode);
            if (stdoutTask.Wait(10000)) outputLimitExceeded |= stdoutTask.Result.LimitExceeded;
            if (stderrTask.Wait(10000)) outputLimitExceeded |= stderrTask.Result.LimitExceeded;
            string stdout = stdoutTask.IsCompleted ? stdoutTask.Result.Text : "";
            string stderr = stderrTask.IsCompleted ? stderrTask.Result.Text : "";
            uint descendantPid = ParsePid(stdout, "DESCENDANT_PID=");
            if (jobClosedByStop && job != IntPtr.Zero) CloseIfSet(ref job);
            bool descendantTerminated = descendantPid == 0 || ProcessTerminated(descendantPid, 5000);

            Print("CHILD_STDOUT_B64", Convert.ToBase64String(Encoding.UTF8.GetBytes(stdout)));
            Print("CHILD_STDERR_B64", Convert.ToBase64String(Encoding.UTF8.GetBytes(stderr)));
            Print("ROOT_EXIT_CODE", exitCode.ToString());
            Print("WALLTIME_EXPIRED", timedOut ? "1" : "0");
            Print("OUTPUT_LIMIT_EXCEEDED", outputLimitExceeded ? "1" : "0");
            Print("HANDLE_LIST_COUNT", "2");
            Print("JOB_KILL_ON_CLOSE", "1");
            Print("JOB_PROCESS_LIMIT", processLimit.ToString());
            Print("JOB_MEMORY_LIMIT", memoryLimit.ToString());
            Print("JOB_CPU_TIME_MS", cpuTimeMs.ToString());
            Print("PARENT_USER_SID", WindowsIdentity.GetCurrent().User.Value);
            Print("STOP_CLOSED_JOB", jobClosedByStop ? "1" : "0");
            Print("ROOT_TERMINATED", rootCompleted ? "1" : "0");
            Print("DESCENDANT_TERMINATED", descendantTerminated ? "1" : "0");
            Print("PROFILE_CREATED", profileCreated ? "1" : "0");
            return 0;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            CloseIfSet(ref stdoutRead);
            CloseIfSet(ref stdoutWrite);
            CloseIfSet(ref stderrRead);
            CloseIfSet(ref stderrWrite);
            if (attributeListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(attributeListBuffer);
            if (capabilityBuffer != IntPtr.Zero) Marshal.FreeHGlobal(capabilityBuffer);
            if (handleListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(handleListBuffer);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (baseToken != IntPtr.Zero) CloseHandle(baseToken);
            if (lowIntegritySid != IntPtr.Zero) LocalFree(lowIntegritySid);
            if (appContainerSid != IntPtr.Zero) LocalFree(appContainerSid);
            if (profileCreated)
            {
                int deleteResult = DeleteAppContainerProfile(profile);
                if (deleteResult != 0) ThrowLastError("DeleteAppContainerProfile", deleteResult);
            }
        }
    }

    private sealed class BoundedRead
    {
        public string Text;
        public bool LimitExceeded;
        public BoundedRead(string text, bool limitExceeded) { Text = text; LimitExceeded = limitExceeded; }
    }

    private static BoundedRead ReadBounded(IntPtr pipe, int limit, IntPtr job)
    {
        using (FileStream stream = new FileStream(new SafeFileHandle(pipe, false), FileAccess.Read, 4096, false))
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[4096];
            bool exceeded = false;
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                int allowed = Math.Max(0, limit - (int)output.Length);
                int keep = Math.Min(allowed, read);
                if (keep > 0) output.Write(buffer, 0, keep);
                if (keep != read)
                {
                    exceeded = true;
                    if (job != IntPtr.Zero) TerminateJobObject(job, 0x00000103);
                    break;
                }
            }
            return new BoundedRead(Encoding.UTF8.GetString(output.ToArray()), exceeded);
        }
    }

    private static void ConfigureJob(IntPtr job, uint processLimit, ulong memoryLimit, uint cpuTimeMs)
    {
        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobLimitJobTime | JobLimitActiveProcess | JobLimitProcessMemory | JobLimitJobMemory | JobLimitKillOnJobClose;
        limits.BasicLimitInformation.PerJobUserTimeLimit = (long)cpuTimeMs * 10000L;
        limits.BasicLimitInformation.ActiveProcessLimit = processLimit;
        limits.ProcessMemoryLimit = new UIntPtr(memoryLimit);
        limits.JobMemoryLimit = new UIntPtr(memoryLimit);
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
        try
        {
            Marshal.StructureToPtr(limits, data, false);
            if (!SetInformationJobObject(job, 9, data, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                ThrowLastError("SetInformationJobObject(ExtendedLimit)", Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(data); }

        CpuRateControlInformation cpu = new CpuRateControlInformation();
        cpu.ControlFlags = CpuRateEnable | CpuRateHardCap;
        cpu.CpuRate = 2000;
        data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CpuRateControlInformation)));
        try
        {
            Marshal.StructureToPtr(cpu, data, false);
            if (!SetInformationJobObject(job, 15, data, (uint)Marshal.SizeOf(typeof(CpuRateControlInformation))))
                ThrowLastError("SetInformationJobObject(CpuRate)", Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    private static void ApplyTestScratchAcl(string directory, IntPtr appContainerSid)
    {
        SecurityIdentifier identity = new SecurityIdentifier(appContainerSid);
        DirectorySecurity security = Directory.GetAccessControl(directory);
        security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.ReadAndExecute | FileSystemRights.Modify,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(directory, security);
    }

    private static IntPtr CreateProjectedEnvironmentBlock()
    {
        string[] names = { "LOCALAPPDATA", "PATH", "SystemRoot" };
        List<string> entries = new List<string>();
        foreach (string name in names)
        {
            string value = Environment.GetEnvironmentVariable(name);
            if (String.IsNullOrEmpty(value))
                throw new InvalidOperationException("required sandbox environment variable missing: " + name);
            entries.Add(name + "=" + value);
        }
        byte[] bytes = Encoding.Unicode.GetBytes(String.Join("\0", entries.ToArray()) + "\0\0");
        IntPtr block = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, block, bytes.Length);
        return block;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static uint ParsePid(string text, string key)
    {
        foreach (string line in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith(key, StringComparison.Ordinal))
            {
                uint pid;
                if (UInt32.TryParse(line.Substring(key.Length), out pid)) return pid;
            }
        }
        return 0;
    }

    private static bool ProcessTerminated(uint pid, uint timeout)
    {
        IntPtr process = OpenProcess(0x00100000 | 0x00001000, false, pid);
        if (process == IntPtr.Zero) return true;
        try { return WaitForSingleObject(process, timeout) == 0; }
        finally { CloseHandle(process); }
    }

    private static void Print(string key, string value) { Console.WriteLine(key + "=" + value); }

    private static void CloseIfSet(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != InvalidHandle)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }

    private static void ThrowLastError(string operation, int code)
    {
        throw new InvalidOperationException(operation + " failed (" + code + ")");
    }
}
