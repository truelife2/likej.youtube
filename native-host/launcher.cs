using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

// Native messaging needs a real .exe on Windows, so this tiny launcher sits
// between Chrome and host.py: it pipes Chrome's stdin/stdout straight through
// to the Python host.
class Launcher
{
    static string Dir()
    {
        return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    }

    static string ReadPython(string dir)
    {
        string fallback = @"C:\ai\ComfyUI_windows_portable\python_embeded\python.exe";
        try
        {
            string cfg = Path.Combine(dir, "launcher.json");
            if (!File.Exists(cfg)) return fallback;
            string s = File.ReadAllText(cfg);
            int i = s.IndexOf("\"python\"", StringComparison.Ordinal);
            if (i < 0) return fallback;
            int colon = s.IndexOf(':', i);
            int q1 = s.IndexOf('"', colon + 1) + 1;
            int q2 = s.IndexOf('"', q1);
            if (q1 <= 0 || q2 <= q1) return fallback;
            return s.Substring(q1, q2 - q1).Replace("\\\\", "\\");
        }
        catch
        {
            return fallback;
        }
    }

    static void Pump(Stream from, Stream to)
    {
        byte[] buf = new byte[8192];
        try
        {
            while (true)
            {
                int n = from.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                to.Write(buf, 0, n);
                to.Flush();
            }
        }
        catch
        {
            // Chrome closed the pipe, or python died. Nothing useful to do.
        }
    }

    static int Main()
    {
        string dir = Dir();
        string py = ReadPython(dir);
        string hostPy = Path.Combine(dir, "host.py");
        if (!File.Exists(py)) py = "python.exe";

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = py;
        psi.Arguments = "-u \"" + hostPy + "\"";
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        Process p;
        try
        {
            p = Process.Start(psi);
        }
        catch (Exception e)
        {
            File.AppendAllText(Path.Combine(dir, "launcher-error.log"),
                DateTime.Now + " start failed: " + e.Message + Environment.NewLine);
            return 1;
        }
        if (p == null) return 1;

        Thread tin = new Thread(delegate ()
        {
            Pump(Console.OpenStandardInput(), p.StandardInput.BaseStream);
            try { p.StandardInput.Close(); } catch { }
        });
        Thread tout = new Thread(delegate ()
        {
            Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput());
        });
        Thread terr = new Thread(delegate ()
        {
            try
            {
                using (FileStream f = File.Open(Path.Combine(dir, "host-stderr.log"),
                    FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    Pump(p.StandardError.BaseStream, f);
            }
            catch { }
        });
        tin.IsBackground = true;
        tout.IsBackground = true;
        terr.IsBackground = true;
        tin.Start();
        tout.Start();
        terr.Start();

        p.WaitForExit();
        return 0;
    }
}
