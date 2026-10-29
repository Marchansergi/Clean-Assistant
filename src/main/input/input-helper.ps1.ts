// Script de PowerShell que compila un pequeño helper en C# y se queda leyendo
// órdenes por stdin. Usa SendInput de Win32: no necesita módulos nativos de Node.
//
// Protocolo (una línea por orden, campos separados por '|'):
//   <id>|<op>|<arg1>|<arg2>...
// Respuesta:
//   <id>|ok|<datos>   o   <id>|err|<mensaje>

export const INPUT_HELPER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CleanAssistantInput {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const uint MOUSE_LEFTDOWN = 0x2, MOUSE_LEFTUP = 0x4, MOUSE_RIGHTDOWN = 0x8, MOUSE_RIGHTUP = 0x10;
  const uint MOUSE_MIDDLEDOWN = 0x20, MOUSE_MIDDLEUP = 0x40, MOUSE_WHEEL = 0x800, MOUSE_HWHEEL = 0x1000;

  static void Send(INPUT i) {
    INPUT[] arr = new INPUT[] { i };
    SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }

  static bool IsExtended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
  }

  static void Key(ushort vk, bool down) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    uint flags = down ? 0u : KEYEVENTF_KEYUP;
    if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
    i.u.ki.dwFlags = flags;
    Send(i);
  }

  static void Unicode(char c, bool down) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (down ? 0u : KEYEVENTF_KEYUP);
    Send(i);
  }

  static void Mouse(uint flags, int data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dwFlags = flags;
    i.u.mi.mouseData = unchecked((uint)data);
    Send(i);
  }

  static uint DownFlag(string b) { return b == "right" ? MOUSE_RIGHTDOWN : b == "middle" ? MOUSE_MIDDLEDOWN : MOUSE_LEFTDOWN; }
  static uint UpFlag(string b) { return b == "right" ? MOUSE_RIGHTUP : b == "middle" ? MOUSE_MIDDLEUP : MOUSE_LEFTUP; }

  // Cada elemento es un código VK en decimal o "c:<carácter>" para resolverlo según la distribución de teclado.
  static ushort ResolveVk(string token) {
    if (token.StartsWith("c:")) {
      short r = VkKeyScan(token[2]);
      if (r == -1) throw new Exception("Tecla no disponible en esta distribución: " + token.Substring(2));
      return (ushort)(r & 0xFF);
    }
    return ushort.Parse(token);
  }

  static string Decode(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }

  static string Handle(string[] p) {
    string op = p[1];
    switch (op) {
      case "ping": return "pong";
      case "pos": { POINT pt; GetCursorPos(out pt); return pt.X + "," + pt.Y; }
      case "move": SetCursorPos(int.Parse(p[2]), int.Parse(p[3])); return "";
      case "down": Mouse(DownFlag(p[2]), 0); return "";
      case "up": Mouse(UpFlag(p[2]), 0); return "";
      case "click": {
        string b = p[2]; int count = int.Parse(p[3]);
        for (int n = 0; n < count; n++) { Mouse(DownFlag(b), 0); Thread.Sleep(15); Mouse(UpFlag(b), 0); if (n < count - 1) Thread.Sleep(60); }
        return "";
      }
      case "wheel": {
        // p[2] = clics (positivo = arriba / derecha), p[3] = "v" o "h"
        int clicks = int.Parse(p[2]);
        uint flag = p[3] == "h" ? MOUSE_HWHEEL : MOUSE_WHEEL;
        int step = clicks > 0 ? 120 : -120;
        for (int n = 0; n < Math.Abs(clicks); n++) { Mouse(flag, step); Thread.Sleep(25); }
        return "";
      }
      case "keydown": foreach (string t in p[2].Split(',')) Key(ResolveVk(t), true); return "";
      case "keyup": { string[] ts = p[2].Split(','); for (int n = ts.Length - 1; n >= 0; n--) Key(ResolveVk(ts[n]), false); return ""; }
      case "combo": {
        string[] ts = p[2].Split(',');
        int repeat = int.Parse(p[3]);
        ushort[] vks = new ushort[ts.Length];
        for (int n = 0; n < ts.Length; n++) vks[n] = ResolveVk(ts[n]);
        for (int r = 0; r < repeat; r++) {
          foreach (ushort vk in vks) { Key(vk, true); Thread.Sleep(8); }
          for (int n = vks.Length - 1; n >= 0; n--) { Key(vks[n], false); Thread.Sleep(8); }
          if (r < repeat - 1) Thread.Sleep(40);
        }
        return "";
      }
      case "type": {
        string text = Decode(p[2]); int delay = int.Parse(p[3]);
        foreach (char c in text) {
          if (c == '\r') continue;
          if (c == '\n') { Key(0x0D, true); Key(0x0D, false); }
          else if (c == '\t') { Key(0x09, true); Key(0x09, false); }
          else { Unicode(c, true); Unicode(c, false); }
          if (delay > 0) Thread.Sleep(delay);
        }
        return "";
      }
      case "releaseall": {
        ushort[] mods = new ushort[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        foreach (ushort m in mods) Key(m, false);
        Mouse(MOUSE_LEFTUP, 0); Mouse(MOUSE_RIGHTUP, 0); Mouse(MOUSE_MIDDLEUP, 0);
        return "";
      }
    }
    throw new Exception("Orden desconocida: " + op);
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Length == 0) continue;
      string[] p = line.Split('|');
      string id = p[0];
      string res;
      try { res = id + "|ok|" + Handle(p); }
      catch (Exception e) { res = id + "|err|" + e.Message.Replace("|", "/").Replace("\n", " "); }
      Console.Out.WriteLine(res);
      Console.Out.Flush();
    }
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[CleanAssistantInput]::Run()
`;
