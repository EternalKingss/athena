---
name: windows-pip-overlay-control
description: Pin/unpin browser Picture-in-Picture windows on Windows for games using always-on-top and click-through styles.
created: 2026-06-01
---

# Windows PiP Overlay Control

Use when the user wants YouTube/browser Picture-in-Picture to stay over a game and not intercept mouse clicks.

## Key lesson
- True exclusive fullscreen often hides normal windows. Tell user to use Borderless Windowed / Windowed Fullscreen.
- A PiP window can be made topmost and click-through with Win32 extended window styles.
- Do not store helper scripts on Athena drive. Put temp scripts under `C:\Users\force\AppData\Local\Temp` or user/project dirs.

## Lock PiP to a specific position/size
Create/use a PowerShell script that:
- Enumerates visible top-level windows with `EnumWindows`
- Matches titles like `picture.?in.?picture|youtube|pip`
- Applies extended styles:
  - `WS_EX_TRANSPARENT = 0x20` for click-through
  - `WS_EX_LAYERED = 0x80000`
  - `WS_EX_NOACTIVATE = 0x08000000`
- Calls `SetWindowPos` with `HWND_TOPMOST = -1`

Use flags:
- `SWP_SHOWWINDOW = 0x0040`
- `SWP_NOACTIVATE = 0x0010`

## Pin exactly where it is
Call `SetWindowPos` with:
- `SWP_NOMOVE = 0x0002`
- `SWP_NOSIZE = 0x0001`
- plus `SWP_SHOWWINDOW | SWP_NOACTIVATE`

## Unlock
Remove at least:
- `WS_EX_TRANSPARENT`
- `WS_EX_NOACTIVATE`

Then call `SetWindowPos` topmost or normal depending desired behavior.

## Gotcha
PowerShell callbacks can be fussy with typed generic lists and inline quoted Add-Type here-strings. Prefer writing a temp `.ps1` file rather than huge inline commands. Use `$script:matches = @()` inside callback scope.