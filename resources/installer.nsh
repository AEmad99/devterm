; DevTerm custom NSIS hooks.
;
; Why this exists:
; Stock electron-builder _CHECK_APP_RUNNING only looks for DevTerm.exe. After a
; normal session the bundled agent (node.exe under app.asar.unpacked) and ConPTY
; children can still hold handles under $INSTDIR. The installer then shows
; "DevTerm is running / cannot be closed" even though the UI is gone — and it
; keeps failing after the user closes anything visible, because those orphans
; were never targeted.
;
; This macro:
; 1. Force-kills DevTerm.exe (process tree).
; 2. Force-kills every process whose ExecutablePath is under a known DevTerm
;    install root (covers agent node.exe).
; 3. Never MessageBox / Quit — stock aborts reinstalls permanently after two
;    failed kills; we always continue so extract can overwrite.

!macro customCheckAppRunning
  DetailPrint "Closing DevTerm and releasing install-directory file locks..."

  ; --- Main app image (tree kill) ---
  nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $0
  Sleep 300
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 500
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 300

  ; --- Install-dir orphans (agent node.exe, leftover helpers) ---
  ; Build a small PowerShell one-liner. NSIS expands $INSTDIR; $$ becomes $.
  ; Avoid `${...}` tokens so the NSIS preprocessor never mis-reads PowerShell.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$roots=@(); foreach($$c in @((Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),(Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),(Join-Path $$env:ProgramFiles 'DevTerm'),(Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),'$INSTDIR')){if($$c -and $$c.Length -gt 3){$$roots+=$$c}}; Get-CimInstance Win32_Process -EA SilentlyContinue | ForEach-Object {$$ep=$$_.ExecutablePath; if(-not $$ep){return}; foreach($$r in $$roots){if($$ep.StartsWith($$r,[StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $$_.ProcessId -Force -EA SilentlyContinue; break}}}"`
  Pop $0

  Sleep 800

  ; Final sweep of the main image after orphans are gone.
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
!macroend
