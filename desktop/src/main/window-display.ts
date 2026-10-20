/**
 * Which screen a window is on (MD·T5–T6): the Meet prompt records that whole screen. One short-lived hidden
 * PowerShell call per prompt, no native module; any failure falls back to the last-used screen, then the primary.
 */
import { execFile } from 'child_process'
import { desktopCapturer, screen, type DesktopCapturerSource, type Display } from 'electron'
import { hwndOf } from '@shared/meetings'

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Per-monitor v2 DPI aware (-4), so the rectangle is in physical pixels, which is what screenToDipPoint expects.
 * MONITOR_DEFAULTTONEAREST (2) also answers for a minimised window: the monitor it would restore to.
 */
const SCRIPT = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MissMinutesMonitor {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public R m; public R w; public int f; }
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MI i);
  public static string Rect(long hwnd) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr mon = MonitorFromWindow(new IntPtr(hwnd), 2);
    MI i = new MI(); i.cb = Marshal.SizeOf(i);
    if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref i)) return "";
    return i.m.l + "," + i.m.t + "," + i.m.r + "," + i.m.b;
  }
}
'@
[MissMinutesMonitor]::Rect(HWND)`

/**
 * The monitor rectangle (physical pixels) of the window `hwnd` (MD·T5); null on any failure. `hwnd` must come from
 * hwndOf (digits only): it is spliced in as a number literal. -EncodedCommand sidesteps command-line quoting.
 */
export function monitorRectOf(hwnd: string): Promise<Rect | null> {
  if (process.platform !== 'win32' || !/^\d+$/.test(hwnd)) return Promise.resolve(null)
  const encoded = Buffer.from(SCRIPT.replace('HWND', hwnd), 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        const parts = error ? [] : stdout.trim().split(',').map(Number)
        if (parts.length !== 4 || !parts.every(Number.isFinite)) return resolve(null)
        const [left, top, right, bottom] = parts
        resolve(
          right > left && bottom > top
            ? { x: left, y: top, width: right - left, height: bottom - top }
            : null
        )
      }
    )
  })
}

/**
 * The screen source (with a 320×180 preview) for the monitor the window `sourceId` is on (MD·T6), plus the display
 * and its 1-based index among displays for screenLabel. Falls back to `fallbackDisplayId`, then the primary display.
 * Never throws.
 */
export async function screenForWindow(
  sourceId: string,
  fallbackDisplayId: string | null,
  log: (text: string) => void
): Promise<{
  source: DesktopCapturerSource
  display: Display
  index: number
  count: number
} | null> {
  try {
    const started = Date.now()
    const hwnd = hwndOf(sourceId)
    const rect = hwnd ? await monitorRectOf(hwnd) : null
    const displays = screen.getAllDisplays()
    let display: Display
    if (rect) {
      const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      display = screen.getDisplayNearestPoint(screen.screenToDipPoint(centre))
    } else {
      log(`meetings: could not locate window ${sourceId}, using the last or primary screen`)
      display =
        displays.find((d) => String(d.id) === fallbackDisplayId) ?? screen.getPrimaryDisplay()
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source) return null
    const index = displays.findIndex((d) => d.id === display.id) + 1 || 1
    log(`meetings: ${sourceId} is on display ${display.id} (${Date.now() - started} ms)`)
    return { source, display, index, count: displays.length }
  } catch (error) {
    log(`meetings: locating ${sourceId} failed: ${error instanceof Error ? error.message : error}`)
    return null
  }
}
