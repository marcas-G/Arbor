using System;
using System.IO;
using System.Text;

// D4a fixed-path process-host artifact. This first slice implements only the
// bounded protocol boundary. It deliberately cannot create a token, profile,
// Job, pipe, or child process; production SandboxProcessPort.run remains
// unavailable until the later D4b/D5/D6 gates are implemented and qualified.
internal static class WindowsSandboxProcessHost
{
    private const int MaximumFrameBytes = 65536;
    private const string RunEnvelopePrefix = "{\"version\":1,\"kind\":\"Run\",\"policy\":";
    private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    private static int Main(string[] args)
    {
        if (args.Length != 0)
        {
            WriteUnavailable("ProtocolFrameInvalid");
            return 2;
        }

        try
        {
            string frame;
            if (!TryReadBoundedFrame(Console.OpenStandardInput(), out frame) ||
                !HasD4aRunEnvelope(frame))
            {
                WriteUnavailable("ProtocolFrameInvalid");
                return 2;
            }

            // D4a is intentionally non-launching. D4b may add validated
            // lifecycle primitives without changing this fail-closed reply
            // until separate D5/D6 qualification authorizes any production edge.
            WriteUnavailable("ProductionRunNotEnabled");
            return 0;
        }
        catch
        {
            // Never echo paths, request bytes, or exception details.
            WriteUnavailable("ProtocolFrameInvalid");
            return 2;
        }
    }

    private static bool TryReadBoundedFrame(Stream input, out string frame)
    {
        frame = String.Empty;
        using (MemoryStream bytes = new MemoryStream())
        {
            bool terminated = false;
            while (bytes.Length <= MaximumFrameBytes)
            {
                int next = input.ReadByte();
                if (next < 0) return false;
                if (next == '\n')
                {
                    terminated = true;
                    break;
                }
                if (next == '\r') return false;
                bytes.WriteByte((byte)next);
            }
            if (!terminated || bytes.Length == 0 || bytes.Length > MaximumFrameBytes)
                return false;

            frame = StrictUtf8.GetString(bytes.ToArray());
            return frame.Length > 0 && frame[0] != '\uFEFF';
        }
    }

    private static bool HasD4aRunEnvelope(string frame)
    {
        // The adapter owns the closed canonical codec. This D4a receiver only
        // checks the fixed envelope; it never interprets fields as authority.
        return frame.StartsWith(RunEnvelopePrefix, StringComparison.Ordinal) &&
               frame.EndsWith("}", StringComparison.Ordinal);
    }

    private static void WriteUnavailable(string failureCode)
    {
        string response = "{\"version\":1,\"kind\":\"Result\",\"outcome\":\"Unavailable\",\"failureCode\":\"" +
            failureCode + "\"}";
        Console.Out.WriteLine(response);
        Console.Out.Flush();
    }
}
