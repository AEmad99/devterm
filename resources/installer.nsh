; DevTerm custom NSIS hooks.
;
; 1. Elevated assisted installs skip stock CHECK_APP_RUNNING on the UAC inner
;    process — so kill must run from customInit too.
; 2. Never treat the installer as the app: ignore *setup* / *Uninstall* images
;    and never taskkill anything except exact DevTerm.exe by name.
; 3. Do NOT wipe INSTDIR in customInit (that runs when the wizard opens and
;    would also delete Uninstall DevTerm.exe before uninstallOldVersion runs).
;    Wipe only in customUnInstallCheck*, after the old uninstaller has been
;    invoked (or skipped), so extract gets a clean directory.
; 4. Unlock uses a temp .ps1 (reliable) instead of a fragile one-liner.

!macro _DevTermWriteKillScript
  FileOpen $R9 "$TEMP\devterm-nsis-kill.ps1" w
  FileWrite $R9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R9 "$$instDir = @'$\r$\n"
  FileWrite $R9 "$INSTDIR$\r$\n"
  FileWrite $R9 "'@.Trim()$\r$\n"
  FileWrite $R9 "function Test-SafeRoot([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return $$false }$\r$\n"
  FileWrite $R9 "  try { $$p = [System.IO.Path]::GetFullPath($$p) } catch { return $$false }$\r$\n"
  FileWrite $R9 "  $$leaf = Split-Path $$p -Leaf$\r$\n"
  FileWrite $R9 "  if ($$leaf -ne 'DevTerm' -and $$leaf -ne 'devterm') { return $$false }$\r$\n"
  FileWrite $R9 "  if ($$p.Length -lt 8) { return $$false }$\r$\n"
  FileWrite $R9 "  return $$true$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "$$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
  FileWrite $R9 "foreach ($$c in @($\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:ProgramFiles 'DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),$\r$\n"
  FileWrite $R9 "  $$instDir$\r$\n"
  FileWrite $R9 ")) { if (Test-SafeRoot $$c) { [void]$$roots.Add($$c) } }$\r$\n"
  FileWrite $R9 "# Exact app image only (Get-Process Name is without .exe)$\r$\n"
  FileWrite $R9 "Get-Process -Name 'DevTerm' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R9 "# Path-based children under install roots; NEVER setup/uninstall$\r$\n"
  FileWrite $R9 "Get-CimInstance Win32_Process | ForEach-Object {$\r$\n"
  FileWrite $R9 "  $$name = $$_.Name$\r$\n"
  FileWrite $R9 "  if ($$name -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$ep = $$_.ExecutablePath$\r$\n"
  FileWrite $R9 "  if (-not $$ep) { return }$\r$\n"
  FileWrite $R9 "  if ($$ep -match '(?i)[\\/].*setup|[\\/]Uninstall') { return }$\r$\n"
  FileWrite $R9 "  foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "    if ($$ep.StartsWith($$r, [StringComparison]::OrdinalIgnoreCase)) {$\r$\n"
  FileWrite $R9 "      Stop-Process -Id $$_.ProcessId -Force$\r$\n"
  FileWrite $R9 "      break$\r$\n"
  FileWrite $R9 "    }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "exit 0$\r$\n"
  FileClose $R9
!macroend

!macro _DevTermWriteWipeScript
  FileOpen $R9 "$TEMP\devterm-nsis-wipe.ps1" w
  FileWrite $R9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R9 "$$instDir = @'$\r$\n"
  FileWrite $R9 "$INSTDIR$\r$\n"
  FileWrite $R9 "'@.Trim()$\r$\n"
  FileWrite $R9 "function Test-SafeRoot([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return $$false }$\r$\n"
  FileWrite $R9 "  try { $$p = [System.IO.Path]::GetFullPath($$p) } catch { return $$false }$\r$\n"
  FileWrite $R9 "  $$leaf = Split-Path $$p -Leaf$\r$\n"
  FileWrite $R9 "  if ($$leaf -ne 'DevTerm' -and $$leaf -ne 'devterm') { return $$false }$\r$\n"
  FileWrite $R9 "  if ($$p.Length -lt 8) { return $$false }$\r$\n"
  FileWrite $R9 "  return $$true$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "$$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
  FileWrite $R9 "foreach ($$c in @($\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:ProgramFiles 'DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),$\r$\n"
  FileWrite $R9 "  $$instDir$\r$\n"
  FileWrite $R9 ")) { if (Test-SafeRoot $$c) { [void]$$roots.Add($$c) } }$\r$\n"
  FileWrite $R9 "Get-Process -Name 'DevTerm' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R9 "Get-CimInstance Win32_Process | ForEach-Object {$\r$\n"
  FileWrite $R9 "  if ($$_.Name -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$ep = $$_.ExecutablePath$\r$\n"
  FileWrite $R9 "  if (-not $$ep -or $$ep -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "    if ($$ep.StartsWith($$r, [StringComparison]::OrdinalIgnoreCase)) {$\r$\n"
  FileWrite $R9 "      Stop-Process -Id $$_.ProcessId -Force; break$\r$\n"
  FileWrite $R9 "    }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "Start-Sleep -Milliseconds 400$\r$\n"
  FileWrite $R9 "foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "  if (-not (Test-Path -LiteralPath $$r)) { continue }$\r$\n"
  FileWrite $R9 "  Get-ChildItem -LiteralPath $$r -Force -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $R9 "    Remove-Item -LiteralPath $$_.FullName -Recurse -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "exit 0$\r$\n"
  FileClose $R9
!macroend

!macro _DevTermKillApp
  DetailPrint "DevTerm: closing DevTerm.exe (ignoring setup/uninstall processes)..."
  ; Exact image name only — DevTerm-*-setup.exe is NOT matched by taskkill /IM.
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  Sleep 150
  !insertmacro _DevTermWriteKillScript
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\devterm-nsis-kill.ps1"`
  Pop $0
  Sleep 250
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  Delete "$TEMP\devterm-nsis-kill.ps1"
!macroend

!macro _DevTermWipeInstallDir
  DetailPrint "DevTerm: wiping previous install files for clean extract..."
  !insertmacro _DevTermWriteWipeScript
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\devterm-nsis-wipe.ps1"`
  Pop $0
  Sleep 300
  Delete "$TEMP\devterm-nsis-wipe.ps1"
!macroend

; Outer + elevated inner .onInit — kill only (do not wipe: uninstaller still needed).
!macro customInit
  !insertmacro _DevTermKillApp
!macroend

; When stock CHECK_APP_RUNNING runs — kill only; wipe happens after uninstall.
!macro customCheckAppRunning
  !insertmacro _DevTermKillApp
!macroend

; After old uninstaller attempt: kill again, wipe leftovers, never abort upgrade.
!macro customUnInstallCheck
  !insertmacro _DevTermKillApp
  !insertmacro _DevTermWipeInstallDir
  ClearErrors
  StrCpy $R0 0
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro _DevTermKillApp
  !insertmacro _DevTermWipeInstallDir
  ClearErrors
  StrCpy $R0 0
!macroend
