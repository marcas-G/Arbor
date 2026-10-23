using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class WindowsSandboxLpacOptOutProbe
{
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint DisableMaxPrivilege = 0x0001;
    private const uint LuaToken = 0x0004;
    private const int TokenIntegrityLevel = 25;
    private const uint SeGroupIntegrity = 0x00000020;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint ErrorBrokenPipe = 109;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const int ProcThreadAttributeAllApplicationPackagesPolicy = 0x0002000f;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private static readonly List<string> cleanupFailures = new List<string>();

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
        public short Reserved2Size;
        public IntPtr Reserved2;
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
    private struct JobBasicLimitInformation
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
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class AclSnapshot
    {
        public string Path;
        public bool IsDirectory;
        public string AccessSddl;
        public string AccessCanonical;
    }

    private sealed class AclLease
    {
        private readonly List<AclSnapshot> snapshots = new List<AclSnapshot>();

        public void GrantDirectory(string path, SecurityIdentifier sid, FileSystemRights rights, InheritanceFlags inheritance)
        {
            DirectorySecurity original = Directory.GetAccessControl(path);
            snapshots.Add(new AclSnapshot
            {
                Path = path,
                IsDirectory = true,
                AccessSddl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access),
                AccessCanonical = CanonicalAccess(original),
            });
            original.AddAccessRule(new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(path, original);
        }

        public void GrantFile(string path, SecurityIdentifier sid, FileSystemRights rights)
        {
            FileSecurity original = File.GetAccessControl(path);
            snapshots.Add(new AclSnapshot
            {
                Path = path,
                IsDirectory = false,
                AccessSddl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access),
                AccessCanonical = CanonicalAccess(original),
            });
            original.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
            File.SetAccessControl(path, original);
        }

        public void GrantAllAppsOnlyReadFile(string path, SecurityIdentifier ownerSid, SecurityIdentifier allAppsSid)
        {
            FileSecurity original = File.GetAccessControl(path);
            snapshots.Add(new AclSnapshot
            {
                Path = path,
                IsDirectory = false,
                AccessSddl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access),
                AccessCanonical = CanonicalAccess(original),
            });
            original.SetAccessRuleProtection(true, false);
            original.AddAccessRule(new FileSystemAccessRule(ownerSid, FileSystemRights.FullControl, AccessControlType.Allow));
            original.AddAccessRule(new FileSystemAccessRule(allAppsSid, FileSystemRights.Read, AccessControlType.Allow));
            File.SetAccessControl(path, original);
        }

        public void RestoreAndVerify()
        {
            Exception firstFailure = null;
            for (int index = snapshots.Count - 1; index >= 0; index--)
            {
                AclSnapshot snapshot = snapshots[index];
                try
                {
                    string restoredCanonical;
                    if (snapshot.IsDirectory)
                    {
                        DirectorySecurity security = Directory.GetAccessControl(snapshot.Path);
                        security.SetSecurityDescriptorSddlForm(snapshot.AccessSddl, AccessControlSections.Access);
                        Directory.SetAccessControl(snapshot.Path, security);
                        restoredCanonical = CanonicalAccess(Directory.GetAccessControl(snapshot.Path));
                    }
                    else
                    {
                        FileSecurity security = File.GetAccessControl(snapshot.Path);
                        security.SetSecurityDescriptorSddlForm(snapshot.AccessSddl, AccessControlSections.Access);
                        File.SetAccessControl(snapshot.Path, security);
                        restoredCanonical = CanonicalAccess(File.GetAccessControl(snapshot.Path));
                    }
                    if (!String.Equals(restoredCanonical, snapshot.AccessCanonical, StringComparison.Ordinal))
                        throw new InvalidOperationException("restored ACL access rules differ from snapshot");
                }
                catch (Exception exception)
                {
                    if (firstFailure == null) firstFailure = exception;
                }
            }
            if (firstFailure != null) throw new InvalidOperationException("ACL restoration failed", firstFailure);
        }

        private static string CanonicalAccess(CommonObjectSecurity security)
        {
            List<string> entries = new List<string>();
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (AuthorizationRule rule in rules)
            {
                FileSystemAccessRule fileRule = rule as FileSystemAccessRule;
                if (fileRule == null) throw new InvalidOperationException("unexpected ACL rule type");
                entries.Add(String.Join("|", new[]
                {
                    ((SecurityIdentifier)fileRule.IdentityReference).Value,
                    ((int)fileRule.FileSystemRights).ToString(),
                    ((int)fileRule.AccessControlType).ToString(),
                    ((int)fileRule.InheritanceFlags).ToString(),
                    ((int)fileRule.PropagationFlags).ToString(),
                    fileRule.IsInherited ? "1" : "0",
                }));
            }
            entries.Sort(StringComparer.Ordinal);
            return String.Join("\n", entries.ToArray());
        }
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DeleteAppContainerProfile(string name);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetAppContainerFolderPath(string appContainerSid, out IntPtr path);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr existingToken, uint flags, uint disabledSidCount, IntPtr disabledSids, uint deletedPrivilegeCount, IntPtr deletedPrivileges, uint restrictedSidCount, IntPtr restrictedSids, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int informationClass, IntPtr information, uint informationLength);

    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributes attributes, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string path, uint desiredAccess, uint shareMode, ref SecurityAttributes attributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr file, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, IntPtr startupInfo, out ProcessInformation processInformation);

    private static int Main(string[] args)
    {
        cleanupFailures.Clear();
        try
        {
            if (args.Length != 0) throw new ArgumentException("no arguments are accepted");
            string executable = Path.GetFullPath(Path.Combine(Environment.SystemDirectory, "cmd.exe"));
            if (!File.Exists(executable)) throw new InvalidOperationException("fixed Windows system cmd.exe is unavailable");
            bool failed = false;
            try { RunOne("REGULAR", false, executable); }
            catch (Exception exception)
            {
                failed = true;
                Console.WriteLine("REGULAR_DRIVER_ERROR_B64=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(exception.GetType().Name + ":" + exception.Message)));
            }
            try { RunOne("LPAC", true, executable); }
            catch (Exception exception)
            {
                failed = true;
                Console.WriteLine("LPAC_DRIVER_ERROR_B64=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(exception.GetType().Name + ":" + exception.Message)));
            }
            Console.WriteLine("CLEANUP_FAILURES=" + cleanupFailures.Count.ToString());
            if (cleanupFailures.Count != 0) throw new InvalidOperationException("native handle cleanup failed");
            return failed ? 1 : 0;
        }
        catch (Exception exception)
        {
            Console.WriteLine("DRIVER_ERROR=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(exception.GetType().Name + ":" + exception.Message)));
            return 1;
        }
    }

    private static void RunOne(string label, bool lpac, string executable)
    {
        string profileName = "ArborLpacProbe-" + Guid.NewGuid().ToString("N");
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr baseToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr lowIntegritySid = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeListBuffer = IntPtr.Zero;
        IntPtr securityCapabilitiesBuffer = IntPtr.Zero;
        IntPtr handleListBuffer = IntPtr.Zero;
        IntPtr policyBuffer = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr startupBuffer = IntPtr.Zero;
        ProcessInformation child = new ProcessInformation();
        bool profileCreated = false;
        bool childStarted = false;
        bool childExited = false;
        bool attributeListInitialized = false;
        AclLease mountLease = new AclLease();
        Exception primaryFailure = null;
        string childOutput = String.Empty;
        string childError = String.Empty;
        string outsideStatus = "MISSING";
        string outsideContent = String.Empty;
        string workspaceStatus = "MISSING";
        string workspaceContent = String.Empty;
        bool workspaceFirstExists = false;
        bool workspaceSecondExists = false;
        string tempStatus = "MISSING";
        string tempContent = String.Empty;
        string tempEnvironmentStatus = "MISSING";
        int exitCode = -1;
        string stage = "CreateAppContainerProfile";
        bool aclRestored = false;
        bool profileDeleted = false;
        string workspace = null;
        try
        {
            int profileResult = CreateAppContainerProfile(profileName, profileName, "Arbor LPAC opt-out probe", IntPtr.Zero, 0, out appContainerSid);
            if (profileResult != 0) throw new InvalidOperationException("CreateAppContainerProfile HRESULT=" + profileResult.ToString("X8"));
            profileCreated = true;
            SecurityIdentifier packageSid = new SecurityIdentifier(appContainerSid);
            string localAppData = GetAppContainerLocalAppData(appContainerSid);
            workspace = Path.Combine(localAppData, "LpacProbeWorkspace");
            string outsideDirectory = Path.Combine(localAppData, "LpacProbeOutside");
            Directory.CreateDirectory(workspace);
            Directory.CreateDirectory(outsideDirectory);
            string outsideFile = Path.Combine(outsideDirectory, "all-apps-only.txt");
            File.WriteAllText(outsideFile, "outside-seed\n", Encoding.ASCII);
            SecurityIdentifier allAppsSid = new SecurityIdentifier("S-1-15-2-1");
            SecurityIdentifier userSid = WindowsIdentity.GetCurrent().User;
            if (userSid == null) throw new InvalidOperationException("host user SID is unavailable");

            mountLease.GrantDirectory(workspace, packageSid, FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
            mountLease.GrantDirectory(outsideDirectory, packageSid, FileSystemRights.Traverse, InheritanceFlags.None);
            mountLease.GrantDirectory(outsideDirectory, allAppsSid, FileSystemRights.ReadAndExecute, InheritanceFlags.None);
            mountLease.GrantAllAppsOnlyReadFile(outsideFile, userSid, allAppsSid);
            Console.WriteLine(label + "_PROFILE_LOCAL_FIXTURE=1");

            stage = "OpenProcessToken";
            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustDefault, out baseToken))
                ThrowLastError(stage);
            if (!CreateRestrictedToken(baseToken, DisableMaxPrivilege | LuaToken, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken))
                ThrowLastError("CreateRestrictedToken");
            if (!ConvertStringSidToSid("S-1-16-4096", out lowIntegritySid)) ThrowLastError("ConvertStringSidToSid(low integrity)");
            SetLowIntegrity(restrictedToken, lowIntegritySid);

            stage = "CreatePipe";
            SecurityAttributes pipeAttributes = new SecurityAttributes();
            pipeAttributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            pipeAttributes.InheritHandle = true;
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0)) ThrowLastError("CreatePipe(stdout)");
            if (!CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0)) ThrowLastError("CreatePipe(stderr)");
            stdinRead = CreateFile("NUL", GenericRead, FileShareRead | FileShareWrite, ref pipeAttributes, OpenExisting, FileAttributeNormal, IntPtr.Zero);
            if (stdinRead == InvalidHandle) ThrowLastError("CreateFile(NUL stdin)");
            if (!SetHandleInformation(stdoutRead, HandleFlagInherit, 0) || !SetHandleInformation(stderrRead, HandleFlagInherit, 0))
                ThrowLastError("SetHandleInformation(parent read pipe)");

            stage = "CreateJobObject";
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");
            SetProbeJobLimits(job);

            stage = "InitializeProcessAttributes";
            int attributeCount = lpac ? 3 : 2;
            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref attributeListSize);
            attributeListBuffer = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeListBuffer, attributeCount, 0, ref attributeListSize))
                ThrowLastError("InitializeProcThreadAttributeList");
            attributeList = attributeListBuffer;
            attributeListInitialized = true;

            SecurityCapabilities capabilities = new SecurityCapabilities();
            capabilities.AppContainerSid = appContainerSid;
            securityCapabilitiesBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(capabilities, securityCapabilitiesBuffer, false);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities), securityCapabilitiesBuffer,
                new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute(SecurityCapabilities)");

            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stderrWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size * 2, stdinRead);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeHandleList), handleListBuffer,
                new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute(HandleList)");

            if (lpac)
            {
                int allPackagesPolicy = 1;
                policyBuffer = Marshal.AllocHGlobal(sizeof(int));
                Marshal.WriteInt32(policyBuffer, allPackagesPolicy);
                if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(ProcThreadAttributeAllApplicationPackagesPolicy), policyBuffer,
                    new IntPtr(sizeof(int)), IntPtr.Zero, IntPtr.Zero))
                    ThrowLastError("UpdateProcThreadAttribute(AllApplicationPackagesPolicy)");
                Console.WriteLine("LPAC_OPT_OUT_ATTRIBUTE_ACCEPTED=1");
            }

            stage = "BuildExplicitEnvironment";
            environmentBlock = BuildEnvironmentBlock(appContainerSid);
            StartupInfo startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Flags = StartfUseStdHandles;
            startup.StdInput = stdinRead;
            startup.StdOutput = stdoutWrite;
            startup.StdError = stderrWrite;
            StartupInfoEx startupEx = new StartupInfoEx();
            startupEx.StartupInfo = startup;
            startupEx.AttributeList = attributeList;
            startupBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(StartupInfoEx)));
            Marshal.StructureToPtr(startupEx, startupBuffer, false);

            stage = "CreateProcessAsUser";
            string commandLine = Quote(executable) + " /d /q /c " + BuildProbeCommand(outsideFile, workspace, localAppData);
            ProcessInformation processInformation;
            if (!CreateProcessAsUser(restrictedToken, executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent | CreateNoWindow, environmentBlock, workspace, startupBuffer, out processInformation))
                ThrowLastError(stage);
            child = processInformation;
            childStarted = true;
            Console.WriteLine(label + "_CHILD_CREATED=1");
            if (!AssignProcessToJobObject(job, child.Process)) ThrowLastError("AssignProcessToJobObject");
            Console.WriteLine(label + "_JOB_ASSIGNED=1");
            if (ResumeThread(child.Thread) == UInt32.MaxValue) ThrowLastError("ResumeThread");
            Close(ref stdoutWrite);
            Close(ref stderrWrite);
            Close(ref stdinRead);

            uint wait = WaitForSingleObject(child.Process, 7000);
            if (wait == WaitTimeout)
            {
                TerminateJobObject(job, 0x00000103);
                WaitForSingleObject(child.Process, 2000);
                throw new TimeoutException(label + " child exceeded 7-second wait");
            }
            if (wait != WaitObject0) ThrowLastError("WaitForSingleObject(child)");
            childExited = true;
            uint childExit;
            if (!GetExitCodeProcess(child.Process, out childExit)) ThrowLastError("GetExitCodeProcess");
            exitCode = unchecked((int)childExit);
            childOutput = ReadPipeToEnd(stdoutRead);
            childError = ReadPipeToEnd(stderrRead);
            outsideStatus = ReadFixtureText(Path.Combine(workspace, "outside-status.txt"));
            outsideContent = ReadFixtureText(Path.Combine(workspace, "outside-output.txt"));
            workspaceContent = ReadFixtureText(Path.Combine(workspace, "workspace-read.txt"));
            workspaceFirstExists = File.Exists(Path.Combine(workspace, "workspace-write-a.txt"));
            workspaceSecondExists = File.Exists(Path.Combine(workspace, "workspace-write-b.txt"));
            workspaceStatus = workspaceContent == "workspace-write" &&
                !workspaceFirstExists && !workspaceSecondExists ? "PASS" : "FAIL";
            tempContent = ReadFixtureText(Path.Combine(workspace, "temp-read.txt"));
            tempEnvironmentStatus = ReadFixtureText(Path.Combine(workspace, "temp-env-status.txt"));
            tempStatus = tempContent == "private-temp" && tempEnvironmentStatus == "PASS" ? "PASS" : "FAIL";
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
        }
        finally
        {
            if (childStarted && !childExited)
            {
                if (job != IntPtr.Zero) TerminateJobObject(job, 0x00000103);
                else if (child.Process != IntPtr.Zero) TerminateProcess(child.Process, 0x00000103);
                if (child.Process != IntPtr.Zero && WaitForSingleObject(child.Process, 2000) == WaitObject0)
                    childExited = true;
            }
            if (child.Process != IntPtr.Zero && !CloseHandle(child.Process)) RecordCleanup(label + "_PROCESS_CLOSE_ERROR", Marshal.GetLastWin32Error());
            if (child.Thread != IntPtr.Zero && !CloseHandle(child.Thread)) RecordCleanup(label + "_THREAD_CLOSE_ERROR", Marshal.GetLastWin32Error());
            Close(ref stdoutWrite);
            Close(ref stderrWrite);
            Close(ref stdinRead);
            Close(ref stdoutRead);
            Close(ref stderrRead);
            if (job != IntPtr.Zero && !CloseHandle(job)) RecordCleanup(label + "_JOB_CLOSE_ERROR", Marshal.GetLastWin32Error());
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            Free(ref startupBuffer);
            Free(ref policyBuffer);
            Free(ref handleListBuffer);
            Free(ref securityCapabilitiesBuffer);
            Free(ref attributeListBuffer);
            Free(ref environmentBlock);
            Close(ref restrictedToken);
            Close(ref baseToken);
            if (lowIntegritySid != IntPtr.Zero) LocalFree(lowIntegritySid);

            try
            {
                mountLease.RestoreAndVerify();
                aclRestored = true;
            }
            catch (Exception exception) { RecordCleanup(label + "_ACL_RESTORE_ERROR", exception.GetType().Name); }
            if (profileCreated)
            {
                profileDeleted = DeleteProfileWithBoundedRetry(profileName);
            }
            if (appContainerSid != IntPtr.Zero && FreeSid(appContainerSid) != IntPtr.Zero)
                RecordCleanup(label + "_PROFILE_SID_FREE_ERROR", Marshal.GetLastWin32Error());
        }

        Console.WriteLine(label + "_PROCESS_STARTED=" + (childStarted ? "1" : "0"));
        Console.WriteLine(label + "_CHILD_EXITED=" + (childExited ? "1" : "0"));
        Console.WriteLine(label + "_CHILD_EXIT_CODE=" + exitCode.ToString());
        Console.WriteLine(label + "_PROFILE_DELETED=" + (profileDeleted ? "1" : "0"));
        Console.WriteLine(label + "_ACL_RESTORED=" + (aclRestored ? "1" : "0"));
        if (childOutput.Length > 0)
        {
            foreach (string line in childOutput.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                Console.WriteLine(label + "_" + line);
        }
        if (childError.Length > 0) Console.WriteLine(label + "_STDERR_B64=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(childError)));
        ReportChildResults(label, outsideStatus, outsideContent, workspaceStatus, workspaceContent, workspaceFirstExists, workspaceSecondExists, tempStatus, tempContent, tempEnvironmentStatus);
        if (primaryFailure != null)
        {
            string message = stage + ":" + primaryFailure.GetType().Name + ":" + primaryFailure.Message;
            Console.WriteLine(label + "_ERROR_B64=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(message)));
        }
        if (!childStarted || !childExited || !aclRestored || !profileDeleted || primaryFailure != null || exitCode != 0 || cleanupFailures.Count != 0)
            throw new InvalidOperationException(label + " probe incomplete or cleanup failed");
    }

    private static string BuildProbeCommand(string outsideFile, string workspace, string localAppData)
    {
        string outsideOutput = Quote(Path.Combine(workspace, "outside-output.txt"));
        string outsideError = Quote(Path.Combine(workspace, "outside-error.txt"));
        string outsideStatus = Quote(Path.Combine(workspace, "outside-status.txt"));
        string workspaceFirst = Quote(Path.Combine(workspace, "workspace-write-a.txt"));
        string workspaceSecond = Quote(Path.Combine(workspace, "workspace-write-b.txt"));
        string workspaceRead = Quote(Path.Combine(workspace, "workspace-read.txt"));
        string tempRead = Quote(Path.Combine(workspace, "temp-read.txt"));
        string tempEnvStatus = Quote(Path.Combine(workspace, "temp-env-status.txt"));
        string localRoot = localAppData.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string prefix = localRoot + Path.DirectorySeparatorChar;
        StringBuilder command = new StringBuilder();
        command.Append("type ").Append(Quote(outsideFile)).Append(" > ").Append(outsideOutput).Append(" 2> ").Append(outsideError);
        command.Append(" & if errorlevel 1 (echo DENIED > ").Append(outsideStatus).Append(") else (echo ALLOWED > ").Append(outsideStatus).Append(")");
        command.Append(" & echo workspace-write > ").Append(workspaceFirst);
        command.Append(" & type ").Append(workspaceFirst).Append(" > ").Append(workspaceRead);
        command.Append(" & move /y ").Append(workspaceFirst).Append(" ").Append(workspaceSecond).Append(" >nul");
        command.Append(" & del ").Append(workspaceSecond).Append(" >nul 2>nul");
        command.Append(" & if not exist \"%TEMP%\\\" mkdir \"%TEMP%\" >nul 2>nul");
        command.Append(" & echo private-temp>\"%TEMP%\\lpac-temp-probe.txt\"");
        command.Append(" & type \"%TEMP%\\lpac-temp-probe.txt\" > ").Append(tempRead);
        command.Append(" & del \"%TEMP%\\lpac-temp-probe.txt\" >nul 2>nul");
        command.Append(" & if /i not \"%TEMP%:~0,").Append(prefix.Length.ToString()).Append("%\"==\"").Append(prefix).Append("\" (echo FAIL > ").Append(tempEnvStatus).Append(")");
        command.Append(" & if /i \"%TEMP%:~0,").Append(prefix.Length.ToString()).Append("%\"==\"").Append(prefix).Append("\" if /i \"%TEMP%\"==\"%TMP%\" (echo PASS > ").Append(tempEnvStatus).Append(")");
        command.Append(" & exit 0");
        return command.ToString();
    }

    private static void ReportChildResults(string label, string outsideStatus, string outsideContent, string workspaceStatus, string workspaceContent, bool workspaceFirstExists, bool workspaceSecondExists, string tempStatus, string tempContent, string tempEnvironmentStatus)
    {
        Console.WriteLine(label + "_OUTSIDE_READ=" + outsideStatus);
        Console.WriteLine(label + "_OUTSIDE_CONTENT_MATCH=" + (outsideContent == "outside-seed\r\n" || outsideContent == "outside-seed\n" ? "1" : "0"));
        Console.WriteLine(label + "_WORKSPACE_OPS=" + workspaceStatus);
        Console.WriteLine(label + "_WORKSPACE_CONTENT_MATCH=" + (workspaceContent == "workspace-write" ? "1" : "0"));
        Console.WriteLine(label + "_WORKSPACE_FIRST_EXISTS=" + (workspaceFirstExists ? "1" : "0"));
        Console.WriteLine(label + "_WORKSPACE_SECOND_EXISTS=" + (workspaceSecondExists ? "1" : "0"));
        Console.WriteLine(label + "_TEMP_OPS=" + tempStatus);
        Console.WriteLine(label + "_TEMP_CONTENT_MATCH=" + (tempContent == "private-temp" ? "1" : "0"));
        Console.WriteLine(label + "_TEMP_ENV_STATUS=" + tempEnvironmentStatus);
    }

    private static string ReadFixtureText(string path)
    {
        return File.Exists(path) ? File.ReadAllText(path).Trim() : "MISSING";
    }

    private static string GetAppContainerLocalAppData(IntPtr appContainerSid)
    {
        IntPtr profilePath = IntPtr.Zero;
        try
        {
            int result = GetAppContainerFolderPath(new SecurityIdentifier(appContainerSid).Value, out profilePath);
            if (result != 0) throw new InvalidOperationException("GetAppContainerFolderPath HRESULT=" + result.ToString("X8"));
            string path = Marshal.PtrToStringUni(profilePath);
            if (String.IsNullOrEmpty(path)) throw new InvalidOperationException("AppContainer profile path is empty");
            return path;
        }
        finally
        {
            if (profilePath != IntPtr.Zero) Marshal.FreeCoTaskMem(profilePath);
        }
    }

    private static void SetProbeJobLimits(IntPtr job)
    {
        JobExtendedLimitInformation limits = new JobExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitActiveProcess | JobObjectLimitKillOnJobClose;
        limits.BasicLimitInformation.ActiveProcessLimit = 4;
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobExtendedLimitInformation)));
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer,
                (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation))))
                ThrowLastError("SetInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static IntPtr BuildEnvironmentBlock(IntPtr appContainerSid)
    {
        IntPtr profilePath = IntPtr.Zero;
        try
        {
            int result = GetAppContainerFolderPath(new SecurityIdentifier(appContainerSid).Value, out profilePath);
            if (result != 0) throw new InvalidOperationException("GetAppContainerFolderPath HRESULT=" + result.ToString("X8"));
            string localAppData = Marshal.PtrToStringUni(profilePath);
            if (String.IsNullOrEmpty(localAppData)) throw new InvalidOperationException("private LocalAppData path is empty");
            Dictionary<string, string> entries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string[] allowlist = new[] { "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ" };
            foreach (string name in allowlist)
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (value != null) entries[name] = value;
            }
            entries["LOCALAPPDATA"] = localAppData;
            StringBuilder block = new StringBuilder();
            List<string> names = new List<string>(entries.Keys);
            names.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string name in names) block.Append(name).Append('=').Append(entries[name]).Append('\0');
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }
        finally
        {
            if (profilePath != IntPtr.Zero) Marshal.FreeCoTaskMem(profilePath);
        }
    }

    private static void SetLowIntegrity(IntPtr token, IntPtr sid)
    {
        TokenMandatoryLabel label = new TokenMandatoryLabel();
        label.Label.Sid = sid;
        label.Label.Attributes = SeGroupIntegrity;
        int size = Marshal.SizeOf(typeof(TokenMandatoryLabel)) + (int)GetLengthSid(sid);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(label, buffer, false);
            if (!SetTokenInformation(token, TokenIntegrityLevel, buffer, (uint)size)) ThrowLastError("SetTokenInformation(TokenIntegrityLevel)");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool DeleteProfileWithBoundedRetry(string profileName)
    {
        uint[] delays = new[] { 0U, 100U, 500U, 2000U };
        for (int attempt = 0; attempt < delays.Length; attempt++)
        {
            if (delays[attempt] > 0) Thread.Sleep((int)delays[attempt]);
            int result = DeleteAppContainerProfile(profileName);
            if (result == 0)
            {
                IntPtr sid;
                int recreate = CreateAppContainerProfile(profileName, profileName, "Arbor profile cleanup probe", IntPtr.Zero, 0, out sid);
                if (recreate != 0 || sid == IntPtr.Zero)
                {
                    if (sid != IntPtr.Zero) FreeSid(sid);
                    Console.WriteLine("PROFILE_RECREATE_HRESULT=" + recreate.ToString("X8"));
                    return false;
                }
                FreeSid(sid);
                return DeleteAppContainerProfile(profileName) == 0;
            }
        }
        return false;
    }

    private static string ReadPipeToEnd(IntPtr pipe)
    {
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[2048];
            while (true)
            {
                uint read;
                if (!ReadFile(pipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if ((uint)error == ErrorBrokenPipe) break;
                    throw new Win32Exception(error, "ReadFile(child output)");
                }
                if (read == 0) break;
                output.Write(buffer, 0, (int)read);
            }
            return Encoding.UTF8.GetString(output.ToArray());
        }
    }

    private static bool IsWithin(string root, string candidate)
    {
        string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
            String.Equals(Path.GetFullPath(root), Path.GetFullPath(candidate), StringComparison.OrdinalIgnoreCase);
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ThrowLastError(string operation)
    {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, operation + " failed");
    }

    private static void Close(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == InvalidHandle) return;
        if (!CloseHandle(handle)) RecordCleanup("HANDLE_CLOSE_ERROR", Marshal.GetLastWin32Error());
        handle = IntPtr.Zero;
    }

    private static void Free(ref IntPtr memory)
    {
        if (memory == IntPtr.Zero) return;
        Marshal.FreeHGlobal(memory);
        memory = IntPtr.Zero;
    }

    private static void RecordCleanup(string key, object value)
    {
        string detail = key + ":" + Convert.ToString(value);
        cleanupFailures.Add(detail);
        Console.WriteLine("CLEANUP_ERROR_B64=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(detail)));
    }
}
