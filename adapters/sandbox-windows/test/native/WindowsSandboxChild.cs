using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class WindowsSandboxChild
{
    private const int TokenIntegrityLevel = 25;
    private const int TokenIsAppContainer = 29;
    private const int TokenPrivileges = 3;

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

    [DllImport("advapi32.dll")]
    private static extern bool IsTokenRestricted(IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    public static int Main(string[] args)
    {
        try
        {
            string mode = args.Length == 0 ? "identity" : args[0];
            if (mode == "descendant") return RunDescendant(args);
            if (mode == "identity") return Identity();
            if (mode == "sleep") return Sleep();
            if (mode == "flood") return Flood();
            if (mode == "memory") return Memory();
            if (mode == "cpu") return Cpu();
            if (mode == "tree") return Tree(args);
            if (mode == "loopback") return Loopback(args);
            Console.WriteLine("UNKNOWN_MODE=1");
            return 23;
        }
        catch (Exception exception)
        {
            Console.WriteLine("CHILD_ERROR=" + exception.GetType().Name);
            return 24;
        }
    }

    private static int Identity()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008 | 0x0002, out token))
            throw new InvalidOperationException("token-open");
        bool appContainer;
        IntPtr data = Marshal.AllocHGlobal(4);
        try
        {
            int returned;
            if (!GetTokenInformation(token, TokenIsAppContainer, data, 4, out returned))
                throw new InvalidOperationException("appcontainer-query");
            appContainer = Marshal.ReadInt32(data) != 0;
        }
        finally { Marshal.FreeHGlobal(data); }

        IntPtr integrity = IntPtr.Zero;
        int size = 0;
        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
        integrity = Marshal.AllocHGlobal(size);
        int integrityRid = -1;
        try
        {
            int returned;
            if (!GetTokenInformation(token, TokenIntegrityLevel, integrity, size, out returned))
                throw new InvalidOperationException("integrity-query");
            IntPtr sid = Marshal.ReadIntPtr(integrity);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            IntPtr subAuthority = GetSidSubAuthority(sid, (uint)(count - 1));
            integrityRid = Marshal.ReadInt32(subAuthority);
        }
        finally { Marshal.FreeHGlobal(integrity); }

        bool inJob;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob))
            throw new InvalidOperationException("job-query");
        string currentSid = WindowsIdentity.GetCurrent().User.Value;
        int enabledPrivilegeCount = EnabledPrivilegeCount(token);
        Console.WriteLine("APPCONTAINER=" + (appContainer ? "1" : "0"));
        Console.WriteLine("IS_TOKEN_RESTRICTED=" + (IsTokenRestricted(token) ? "1" : "0"));
        Console.WriteLine("ENABLED_PRIVILEGE_COUNT=" + enabledPrivilegeCount);
        Console.WriteLine("LOW_INTEGRITY=" + (integrityRid == 0x1000 ? "1" : "0"));
        Console.WriteLine("IN_JOB=" + (inJob ? "1" : "0"));
        Console.WriteLine("USER_SID=" + currentSid);
        Console.WriteLine("PATH_PRESENT=" + (Environment.GetEnvironmentVariable("PATH") == null ? "0" : "1"));
        Console.WriteLine("SYSTEMROOT_PRESENT=" + (Environment.GetEnvironmentVariable("SystemRoot") == null ? "0" : "1"));
        Console.WriteLine("LOCALAPPDATA_PRESENT=" + (Environment.GetEnvironmentVariable("LOCALAPPDATA") == null ? "0" : "1"));
        Console.WriteLine("SENTINEL_PRESENT=" + (Environment.GetEnvironmentVariable("ARBOR_SANDBOX_SENTINEL") == null ? "0" : "1"));
        List<string> environmentNames = new List<string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            environmentNames.Add(entry.Key.ToString());
        environmentNames.Sort(StringComparer.OrdinalIgnoreCase);
        Console.WriteLine("ENVIRONMENT_NAMES=" + String.Join(",", environmentNames.ToArray()));
        Console.WriteLine("STDIN_INVALID=" + (GetStdHandle(-10) == new IntPtr(-1) ? "1" : "0"));
        Console.WriteLine("STDOUT_PRESENT=" + (GetStdHandle(-11) != IntPtr.Zero ? "1" : "0"));
        Console.WriteLine("STDERR_PRESENT=" + (GetStdHandle(-12) != IntPtr.Zero ? "1" : "0"));
        return 0;
    }

    private static int EnabledPrivilegeCount(IntPtr token)
    {
        int size = 0;
        GetTokenInformation(token, TokenPrivileges, IntPtr.Zero, 0, out size);
        IntPtr privileges = Marshal.AllocHGlobal(size);
        try
        {
            int returned;
            if (!GetTokenInformation(token, TokenPrivileges, privileges, size, out returned))
                throw new InvalidOperationException("privilege-query");
            int count = Marshal.ReadInt32(privileges);
            int enabled = 0;
            IntPtr entry = new IntPtr(privileges.ToInt64() + 4);
            for (int index = 0; index < count; index++)
            {
                int attributes = Marshal.ReadInt32(entry, index * 12 + 8);
                if ((attributes & 0x00000002) != 0) enabled++;
            }
            return enabled;
        }
        finally { Marshal.FreeHGlobal(privileges); }
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    private static int Sleep()
    {
        Console.WriteLine("SLEEPING=1");
        Console.Out.Flush();
        Thread.Sleep(30000);
        return 0;
    }

    private static int Flood()
    {
        string block = new string('x', 4096);
        Console.Out.Write(block);
        Console.Out.Flush();
        return 0;
    }

    private static int Memory()
    {
        Console.WriteLine("ALLOCATING=1");
        Console.Out.Flush();
        byte[] allocation = new byte[64 * 1024 * 1024];
        for (int i = 0; i < allocation.Length; i += 4096) allocation[i] = 1;
        Console.WriteLine("ALLOCATED=1");
        GC.KeepAlive(allocation);
        return 0;
    }

    private static int Cpu()
    {
        Console.WriteLine("BURNING_CPU=1");
        Console.Out.Flush();
        long value = 1;
        while (true) value = unchecked(value * 1664525 + 1013904223);
    }

    private static int Tree(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        int parentPid = Process.GetCurrentProcess().Id;
        ProcessStartInfo start = new ProcessStartInfo(self, "descendant " + self + " " + parentPid);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process descendant = Process.Start(start);
        Console.WriteLine("DESCENDANT_PID=" + descendant.Id);
        Console.Out.Flush();
        string report = Path.Combine(Path.GetDirectoryName(self), "tree-result-" + parentPid + ".txt");
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (!File.Exists(report) && DateTime.UtcNow < deadline) Thread.Sleep(25);
        if (File.Exists(report))
        {
            foreach (string line in File.ReadAllLines(report)) Console.WriteLine(line);
        }
        else Console.WriteLine("DESCENDANT_RESULT_MISSING=1");
        Console.Out.Flush();
        Thread.Sleep(30000);
        return 0;
    }

    private static int RunDescendant(string[] args)
    {
        string self = args.Length > 1 ? args[1] : Process.GetCurrentProcess().MainModule.FileName;
        int parentPid = args.Length > 2 ? Int32.Parse(args[2]) : 0;
        string report = Path.Combine(Path.GetDirectoryName(self), "tree-result-" + parentPid + ".txt");
        string result;
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(self, "third " + self);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            Process third = Process.Start(start);
            result = "THIRD_CREATED=1";
            third.Kill();
        }
        catch (System.ComponentModel.Win32Exception exception)
        {
            result = "THIRD_CREATED=0\nTHIRD_ERROR=" + exception.NativeErrorCode;
        }
        File.WriteAllText(report, result, Encoding.UTF8);
        Thread.Sleep(30000);
        return 0;
    }

    private static int Loopback(string[] args)
    {
        int port = Int32.Parse(args[1]);
        try
        {
            using (TcpClient client = new TcpClient())
            {
                client.Connect("127.0.0.1", port);
                Console.WriteLine("LOOPBACK_CONNECTED=1");
            }
        }
        catch (Exception)
        {
            Console.WriteLine("LOOPBACK_CONNECTED=0");
        }
        return 0;
    }
}
