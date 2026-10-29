using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Fixed adapter-owned qualification bridge source. The production provider does not launch it.
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
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileAttributeDirectory = 0x00000010;

    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    private sealed class DirectoryAclSnapshot
    {
        public string Path;
        public string OriginalAccessSddl;
    }

    private sealed class FileAclSnapshot
    {
        public string Path;
        public string OriginalAccessSddl;
    }

    private sealed class TemporaryDirectoryAcls
    {
        private readonly List<DirectoryAclSnapshot> snapshots = new List<DirectoryAclSnapshot>();
        private readonly List<FileAclSnapshot> fileSnapshots = new List<FileAclSnapshot>();

        public int Count { get { return snapshots.Count + fileSnapshots.Count; } }

        public void Grant(string path, SecurityIdentifier identity, FileSystemRights rights, InheritanceFlags inheritance)
        {
            DirectorySecurity original = Directory.GetAccessControl(path);
            DirectoryAclSnapshot snapshot = new DirectoryAclSnapshot();
            snapshot.Path = path;
            snapshot.OriginalAccessSddl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            NormalizeAccessSddl(snapshot.OriginalAccessSddl);
            snapshots.Add(snapshot);

            DirectorySecurity modified = Directory.GetAccessControl(path);
            modified.AddAccessRule(new FileSystemAccessRule(identity, rights, inheritance,
                PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(path, modified);
        }

        public void GrantFile(string path, SecurityIdentifier identity, FileSystemRights rights)
        {
            FileSecurity original = File.GetAccessControl(path);
            FileAclSnapshot snapshot = new FileAclSnapshot();
            snapshot.Path = path;
            snapshot.OriginalAccessSddl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            NormalizeAccessSddl(snapshot.OriginalAccessSddl);
            fileSnapshots.Add(snapshot);

            FileSecurity modified = File.GetAccessControl(path);
            modified.AddAccessRule(new FileSystemAccessRule(identity, rights, AccessControlType.Allow));
            File.SetAccessControl(path, modified);
        }

        public void RestoreAndVerify()
        {
            Exception firstFailure = null;
            for (int index = fileSnapshots.Count - 1; index >= 0; index--)
            {
                FileAclSnapshot snapshot = fileSnapshots[index];
                try
                {
                    FileSecurity restore = File.GetAccessControl(snapshot.Path);
                    restore.SetSecurityDescriptorSddlForm(snapshot.OriginalAccessSddl, AccessControlSections.Access);
                    File.SetAccessControl(snapshot.Path, restore);
                    string restored = File.GetAccessControl(snapshot.Path)
                        .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                    if (!String.Equals(NormalizeAccessSddl(restored), NormalizeAccessSddl(snapshot.OriginalAccessSddl), StringComparison.Ordinal))
                        throw new InvalidOperationException("file ACL snapshot mismatch after restore: " +
                            AclEntryDifference(snapshot.OriginalAccessSddl, restored));
                }
                catch (Exception exception)
                {
                    if (firstFailure == null) firstFailure = exception;
                }
            }
            for (int index = snapshots.Count - 1; index >= 0; index--)
            {
                DirectoryAclSnapshot snapshot = snapshots[index];
                try
                {
                    DirectorySecurity restore = Directory.GetAccessControl(snapshot.Path);
                    restore.SetSecurityDescriptorSddlForm(snapshot.OriginalAccessSddl, AccessControlSections.Access);
                    Directory.SetAccessControl(snapshot.Path, restore);
                    string restored = Directory.GetAccessControl(snapshot.Path)
                        .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                    if (!String.Equals(NormalizeAccessSddl(restored), NormalizeAccessSddl(snapshot.OriginalAccessSddl), StringComparison.Ordinal))
                        throw new InvalidOperationException("ACL snapshot mismatch after restore: " +
                            AclEntryDifference(snapshot.OriginalAccessSddl, restored));
                }
                catch (Exception exception)
                {
                    if (firstFailure == null) firstFailure = exception;
                }
            }
            if (firstFailure != null) throw new InvalidOperationException("test ACL restore failed", firstFailure);
        }

        private static string NormalizeAccessSddl(string sddl)
        {
            int firstAce = sddl.IndexOf('(');
            if (firstAce < 0) return sddl;
            string[] entries = sddl.Substring(firstAce).Split(new[] { ')' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string entry in entries)
                if (!entry.StartsWith("(A;", StringComparison.Ordinal))
                    throw new InvalidOperationException("temporary ACL has order-sensitive or unsupported ACE");
            Array.Sort(entries, StringComparer.Ordinal);
            return sddl.Substring(0, firstAce) + String.Join(")", entries);
        }

        private static string AclEntryDifference(string before, string after)
        {
            string[] oldEntries = before.Split(new[] { ')' }, StringSplitOptions.RemoveEmptyEntries);
            string[] newEntries = after.Split(new[] { ')' }, StringSplitOptions.RemoveEmptyEntries);
            HashSet<string> oldSet = new HashSet<string>(oldEntries, StringComparer.Ordinal);
            HashSet<string> newSet = new HashSet<string>(newEntries, StringComparer.Ordinal);
            int added = 0;
            int removed = 0;
            foreach (string entry in newSet) if (!oldSet.Contains(entry)) added++;
            foreach (string entry in oldSet) if (!newSet.Contains(entry)) removed++;
            return "before=" + oldEntries.Length + ",after=" + newEntries.Length + ",added=" + added + ",removed=" + removed;
        }
    }

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

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    private sealed class JobLimitSnapshot
    {
        public ExtendedLimitInformation Extended;
        public CpuRateControlInformation Cpu;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributes attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateEvent(ref SecurityAttributes attributes, bool manualReset, bool initialState, string name);

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
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, out uint returnLength);

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
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr securityAttributes, uint creationDisposition, uint flags, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint capacity, uint flags);

    public static int Main(string[] args)
    {
        if (args.Length >= 3 && args[0] == "inspect-root")
        {
            try
            {
                int holdMs = args.Length == 4 ? (int)ParseBounded(args[3], 1, 5000, "hold-ms") : 0;
                if (args.Length != 3 && args.Length != 4) throw new ArgumentException("invalid inspector arguments");
                return InspectRoot(args[1], args[2], holdMs);
            }
            catch (Exception exception)
            {
                Print("INSPECT_STATUS", "Rejected");
                Print("INSPECT_REASON", exception.GetType().Name);
                return 4;
            }
        }
        bool resourceMode = args.Length > 2 && (args[2] == "filesystem" || args[2] == "reparse");
        if (args.Length == 0 || args[0] != "launch" || args.Length != (resourceMode ? 9 : 8))
        {
            Console.Error.WriteLine("invalid test harness arguments");
            return 2;
        }
        try
        {
            string child = Path.GetFullPath(args[1]);
            string mode = args[2];
            string resourceRoot = resourceMode ? ValidateDisposableResourceRoot(args[8]) : null;
            if (mode == "reparse")
            {
                Console.WriteLine("REPARSE_REJECTED=" + (ContainsReparsePoint(Path.Combine(resourceRoot, "admitted")) ? "1" : "0"));
                return 0;
            }
            uint wallTimeMs = ParseBounded(args[3], 100, 60000, "walltime");
            int stdoutBytes = (int)ParseBounded(args[4], 64, 1048576, "stdout");
            int stderrBytes = (int)ParseBounded(args[5], 64, 1048576, "stderr");
            uint processCount = ParseBounded(args[6], 1, 16, "process-count");
            ulong memoryBytes = ParseBounded64(args[7], 64UL * 1024UL * 1024UL, 1024UL * 1024UL * 1024UL, "memory");
            uint cpuTimeMs = mode == "cpu" ? 500U : 5000U;
            uint closeAfterMs = mode == "tree" ? 1200U : 0U;
            return Launch(child, mode, wallTimeMs, stdoutBytes, stderrBytes, processCount, memoryBytes, cpuTimeMs, closeAfterMs, resourceRoot);
        }
        catch (Exception exception)
        {
            Console.WriteLine("HARNESS_ERROR=" + exception.GetType().Name + ":" + exception.Message +
                (exception.InnerException == null ? "" : ":" + exception.InnerException.GetType().Name + ":" + exception.InnerException.Message));
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

    private static string ValidateDisposableResourceRoot(string value)
    {
        string root = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!root.StartsWith(temp, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(root).StartsWith("arbor-sandbox-t3b-", StringComparison.Ordinal) ||
            !Directory.Exists(Path.Combine(root, "admitted")))
            throw new ArgumentException("resource root must be a disposable T3-B fixture under TEMP");
        return root;
    }

    private static int InspectRoot(string fixtureValue, string targetRelativePath, int holdMs)
    {
        string fixture = ValidateDisposableResourceRoot(fixtureValue);
        string admitted = Path.GetFullPath(Path.Combine(fixture, "admitted")).TrimEnd(Path.DirectorySeparatorChar);
        string target = Path.GetFullPath(Path.Combine(fixture, targetRelativePath)).TrimEnd(Path.DirectorySeparatorChar);
        if (!target.Equals(admitted, StringComparison.OrdinalIgnoreCase) &&
            !target.StartsWith(admitted + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            return RejectInspection("OutsideAdmittedRoot");

        List<IntPtr> held = new List<IntPtr>();
        List<string> heldPaths = new List<string>();
        List<ByHandleFileInformation> heldInformation = new List<ByHandleFileInformation>();
        try
        {
            string volumeRoot = Path.GetPathRoot(target);
            string[] components = target.Substring(volumeRoot.Length)
                .Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            string current = volumeRoot;
            string admittedFinal = null;
            string targetFinal = null;
            ByHandleFileInformation targetInformation = new ByHandleFileInformation();
            for (int index = -1; index < components.Length; index++)
            {
                if (index >= 0) current = Path.Combine(current, components[index]);
                IntPtr handle = CreateFile(current, FileReadAttributes, FileShareRead | FileShareWrite,
                    IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint | FileFlagBackupSemantics, IntPtr.Zero);
                if (handle == InvalidHandle) throw new InvalidOperationException("open component failed (" + Marshal.GetLastWin32Error() + ")");
                held.Add(handle);
                heldPaths.Add(current);
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information))
                    throw new InvalidOperationException("component information failed (" + Marshal.GetLastWin32Error() + ")");
                heldInformation.Add(information);
                if ((information.FileAttributes & FileAttributeReparsePoint) != 0)
                    return RejectInspection("ReparsePoint");
                if (current.Equals(admitted, StringComparison.OrdinalIgnoreCase))
                    admittedFinal = FinalPath(handle);
                if (current.Equals(target, StringComparison.OrdinalIgnoreCase))
                {
                    targetFinal = FinalPath(handle);
                    targetInformation = information;
                }
            }

            if (admittedFinal == null || targetFinal == null) return RejectInspection("MissingHandleIdentity");
            admittedFinal = admittedFinal.TrimEnd(Path.DirectorySeparatorChar);
            if (!targetFinal.Equals(admittedFinal, StringComparison.OrdinalIgnoreCase) &&
                !targetFinal.StartsWith(admittedFinal + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return RejectInspection("FinalPathOutsideRoot");
            if ((targetInformation.FileAttributes & FileAttributeDirectory) == 0 && targetInformation.NumberOfLinks != 1)
                return RejectInspection("HardLinkCount");

            if (holdMs > 0)
            {
                Print("INSPECT_HANDLES_HELD", "1");
                Console.Out.Flush();
                Thread.Sleep(holdMs);
            }
            if (!PathIdentitiesStillMatch(heldPaths, heldInformation)) return RejectInspection("PathChangedDuringInspection");
            Print("INSPECT_STATUS", "AdmissibleSnapshot");
            Print("INSPECT_COMPONENTS_HELD", held.Count.ToString());
            Print("INSPECT_TARGET_LINK_COUNT", targetInformation.NumberOfLinks.ToString());
            Print("INSPECT_TARGET_VOLUME_SERIAL", targetInformation.VolumeSerialNumber.ToString("X8"));
            Print("INSPECT_TARGET_FILE_ID", targetInformation.FileIndexHigh.ToString("X8") + targetInformation.FileIndexLow.ToString("X8"));
            return 0;
        }
        finally
        {
            for (int index = held.Count - 1; index >= 0; index--) CloseHandle(held[index]);
        }
    }

    private static bool PathIdentitiesStillMatch(List<string> paths, List<ByHandleFileInformation> original)
    {
        for (int index = 0; index < paths.Count; index++)
        {
            IntPtr reopened = CreateFile(paths[index], FileReadAttributes, FileShareRead | FileShareWrite,
                IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint | FileFlagBackupSemantics, IntPtr.Zero);
            if (reopened == InvalidHandle) return false;
            try
            {
                ByHandleFileInformation current;
                if (!GetFileInformationByHandle(reopened, out current)) return false;
                if ((current.FileAttributes & FileAttributeReparsePoint) != 0 ||
                    current.VolumeSerialNumber != original[index].VolumeSerialNumber ||
                    current.FileIndexHigh != original[index].FileIndexHigh ||
                    current.FileIndexLow != original[index].FileIndexLow)
                    return false;
                if (index == paths.Count - 1 &&
                    (current.FileAttributes & FileAttributeDirectory) == 0 && current.NumberOfLinks != 1)
                    return false;
            }
            finally { CloseHandle(reopened); }
        }
        return true;
    }

    private static string FinalPath(IntPtr handle)
    {
        StringBuilder path = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity)
            throw new InvalidOperationException("final handle path unavailable (" + Marshal.GetLastWin32Error() + ")");
        return path.ToString();
    }

    private static int RejectInspection(string reason)
    {
        Print("INSPECT_STATUS", "Rejected");
        Print("INSPECT_REASON", reason);
        return 0;
    }

    private static bool ContainsReparsePoint(string root)
    {
        Stack<string> pending = new Stack<string>();
        pending.Push(root);
        int visited = 0;
        while (pending.Count > 0)
        {
            string path = pending.Pop();
            visited++;
            if (visited > 128) throw new InvalidOperationException("reparse preflight entry bound exceeded");
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return true;
            if ((attributes & FileAttributes.Directory) == 0) continue;
            foreach (string entry in Directory.GetFileSystemEntries(path)) pending.Push(entry);
        }
        return false;
    }

    private static int Launch(string child, string mode, uint wallTimeMs, int stdoutLimit, int stderrLimit, uint processLimit, ulong memoryLimit, uint cpuTimeMs, uint closeAfterMs, string resourceRoot)
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
        IntPtr inheritableSentinel = IntPtr.Zero;
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
        JobLimitSnapshot configuredJob = null;
        BasicAccountingInformation accounting = new BasicAccountingInformation();
        bool accountingAvailable = false;
        bool sentinelInheritable = false;
        TemporaryDirectoryAcls temporaryAcls = new TemporaryDirectoryAcls();
        TcpListener listener = null;
        int networkPort = 0;
        uint exitCode = UInt32.MaxValue;
        try
        {
            int profileResult = CreateAppContainerProfile(profile, profile, "Arbor test-only sandbox profile", IntPtr.Zero, 0, out appContainerSid);
            if (profileResult != 0) ThrowLastError("CreateAppContainerProfile", profileResult);
            profileCreated = true;

            SecurityIdentifier appContainerIdentity = new SecurityIdentifier(appContainerSid);
            temporaryAcls.Grant(Path.GetDirectoryName(child), appContainerIdentity,
                mode == "tree" ? FileSystemRights.Modify | FileSystemRights.ReadAndExecute : FileSystemRights.ReadAndExecute,
                InheritanceFlags.None);
            temporaryAcls.GrantFile(child, appContainerIdentity, FileSystemRights.ReadAndExecute);
            if (mode == "filesystem")
            {
                temporaryAcls.Grant(resourceRoot, appContainerIdentity, FileSystemRights.ReadAndExecute, InheritanceFlags.None);
                temporaryAcls.Grant(Path.Combine(resourceRoot, "admitted"), appContainerIdentity,
                    FileSystemRights.Modify | FileSystemRights.ReadAndExecute, InheritanceFlags.None);
                temporaryAcls.GrantFile(Path.Combine(resourceRoot, "admitted", "root.txt"),
                    appContainerIdentity, FileSystemRights.Modify | FileSystemRights.ReadAndExecute);
            }
            if (mode == "network")
            {
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                networkPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            }
            if (mode == "fail-after-acl")
                throw new InvalidOperationException("injected failure after ACL grants");

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
            inheritableSentinel = CreateEvent(ref pipeAttributes, false, false, null);
            if (inheritableSentinel == IntPtr.Zero) ThrowLastError("CreateEvent(inheritance sentinel)", Marshal.GetLastWin32Error());
            uint sentinelFlags;
            if (!GetHandleInformation(inheritableSentinel, out sentinelFlags))
                ThrowLastError("GetHandleInformation(inheritance sentinel)", Marshal.GetLastWin32Error());
            sentinelInheritable = (sentinelFlags & HandleFlagInherit) != 0;
            if (!sentinelInheritable) throw new InvalidOperationException("inheritance sentinel not inheritable");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject", Marshal.GetLastWin32Error());
            ConfigureJob(job, processLimit, memoryLimit, cpuTimeMs);
            configuredJob = ReadJobLimits(job);

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

            int handleCount = mode == "handle-positive" ? 3 : 2;
            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * handleCount);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stderrWrite);
            if (handleCount == 3) Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size * 2, inheritableSentinel);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeHandleList), handleListBuffer, new IntPtr(IntPtr.Size * handleCount), IntPtr.Zero, IntPtr.Zero))
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
                string commandLine = Quote(child) + " " + Quote(mode == "handle-positive" ? "identity" : mode);
                if (mode == "identity" || mode == "handle-positive") commandLine += " " + inheritableSentinel.ToInt64().ToString();
                if (mode == "filesystem") commandLine += " " + Quote(resourceRoot);
                if (mode == "network") commandLine += " " + networkPort.ToString();
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

            if (rootCompleted && !GetExitCodeProcess(process.Process, out exitCode))
                ThrowLastError("GetExitCodeProcess", Marshal.GetLastWin32Error());
            if (job != IntPtr.Zero)
            {
                accounting = ReadJobAccounting(job);
                accountingAvailable = true;
            }
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
            Print("ROOT_EXIT_CODE_HEX", exitCode.ToString("X8"));
            Print("WALLTIME_EXPIRED", timedOut ? "1" : "0");
            Print("OUTPUT_LIMIT_EXCEEDED", outputLimitExceeded ? "1" : "0");
            Print("HANDLE_LIST_COUNT", (mode == "handle-positive" ? 3 : 2).ToString());
            Print("PARENT_SENTINEL_INHERITABLE", sentinelInheritable ? "1" : "0");
            Print("PARENT_SENTINEL_HANDLE_VALUE", inheritableSentinel.ToInt64().ToString());
            if (listener != null) Print("LOCAL_LISTENER_PENDING", listener.Pending() ? "1" : "0");
            Print("JOB_LIMIT_FLAGS", configuredJob.Extended.BasicLimitInformation.LimitFlags.ToString());
            Print("JOB_KILL_ON_CLOSE", (configuredJob.Extended.BasicLimitInformation.LimitFlags & JobLimitKillOnJobClose) != 0 ? "1" : "0");
            Print("JOB_PROCESS_LIMIT", configuredJob.Extended.BasicLimitInformation.ActiveProcessLimit.ToString());
            Print("JOB_PROCESS_MEMORY_LIMIT", configuredJob.Extended.ProcessMemoryLimit.ToUInt64().ToString());
            Print("JOB_MEMORY_LIMIT", configuredJob.Extended.JobMemoryLimit.ToUInt64().ToString());
            Print("JOB_CPU_TIME_MS", (configuredJob.Extended.BasicLimitInformation.PerJobUserTimeLimit / 10000L).ToString());
            Print("JOB_CPU_RATE_FLAGS", configuredJob.Cpu.ControlFlags.ToString());
            Print("JOB_CPU_RATE", configuredJob.Cpu.CpuRate.ToString());
            Print("JOB_ACCOUNTING_AVAILABLE", accountingAvailable ? "1" : "0");
            if (accountingAvailable)
            {
                Print("JOB_TOTAL_USER_TIME_MS", (accounting.TotalUserTime / 10000L).ToString());
                Print("JOB_TOTAL_TERMINATED_PROCESSES", accounting.TotalTerminatedProcesses.ToString());
            }
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
            if (process.Process != IntPtr.Zero && !rootCompleted)
            {
                TerminateProcess(process.Process, 0x00000104);
                WaitForSingleObject(process.Process, 5000);
            }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            CloseIfSet(ref stdoutRead);
            CloseIfSet(ref stdoutWrite);
            CloseIfSet(ref stderrRead);
            CloseIfSet(ref stderrWrite);
            CloseIfSet(ref inheritableSentinel);
            if (listener != null) listener.Stop();
            if (attributeListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(attributeListBuffer);
            if (capabilityBuffer != IntPtr.Zero) Marshal.FreeHGlobal(capabilityBuffer);
            if (handleListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(handleListBuffer);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (baseToken != IntPtr.Zero) CloseHandle(baseToken);
            if (lowIntegritySid != IntPtr.Zero) LocalFree(lowIntegritySid);
            if (appContainerSid != IntPtr.Zero) LocalFree(appContainerSid);
            Exception cleanupFailure = null;
            try
            {
                temporaryAcls.RestoreAndVerify();
                Print("ACL_SNAPSHOTS_RESTORED", temporaryAcls.Count.ToString());
                Print("ACL_RESTORED", "1");
            }
            catch (Exception exception)
            {
                Print("ACL_RESTORED", "0");
                cleanupFailure = exception;
            }
            if (profileCreated)
            {
                int deleteResult = DeleteAppContainerProfile(profile);
                if (deleteResult != 0 && cleanupFailure == null)
                    cleanupFailure = new InvalidOperationException("DeleteAppContainerProfile failed (" + deleteResult + ")");
                if (deleteResult == 0) Print("PROFILE_DELETED", "1");
            }
            if (cleanupFailure != null) throw cleanupFailure;
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

    private static JobLimitSnapshot ReadJobLimits(IntPtr job)
    {
        JobLimitSnapshot snapshot = new JobLimitSnapshot();
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, 9, data, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)), out returned))
                ThrowLastError("QueryInformationJobObject(ExtendedLimit)", Marshal.GetLastWin32Error());
            if (returned < Marshal.SizeOf(typeof(ExtendedLimitInformation)))
                throw new InvalidOperationException("short Job Object extended limit readback");
            snapshot.Extended = (ExtendedLimitInformation)Marshal.PtrToStructure(data, typeof(ExtendedLimitInformation));
        }
        finally { Marshal.FreeHGlobal(data); }

        data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CpuRateControlInformation)));
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, 15, data, (uint)Marshal.SizeOf(typeof(CpuRateControlInformation)), out returned))
                ThrowLastError("QueryInformationJobObject(CpuRate)", Marshal.GetLastWin32Error());
            if (returned < Marshal.SizeOf(typeof(CpuRateControlInformation)))
                throw new InvalidOperationException("short Job Object CPU rate readback");
            snapshot.Cpu = (CpuRateControlInformation)Marshal.PtrToStructure(data, typeof(CpuRateControlInformation));
        }
        finally { Marshal.FreeHGlobal(data); }
        return snapshot;
    }

    private static BasicAccountingInformation ReadJobAccounting(IntPtr job)
    {
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BasicAccountingInformation)));
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, 1, data, (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)), out returned))
                ThrowLastError("QueryInformationJobObject(BasicAccounting)", Marshal.GetLastWin32Error());
            if (returned < Marshal.SizeOf(typeof(BasicAccountingInformation)))
                throw new InvalidOperationException("short Job Object accounting readback");
            return (BasicAccountingInformation)Marshal.PtrToStructure(data, typeof(BasicAccountingInformation));
        }
        finally { Marshal.FreeHGlobal(data); }
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
        return "\"" + value.Replace("\"", "\\\"") + "\"";
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
