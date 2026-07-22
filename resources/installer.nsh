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
; 4. Robust process killing handles 8.3 short paths, forward slashes, and
;    unlocked/orphaned background processes (e.g. node.exe agent runtime).
; 5. Override customRemoveFiles to avoid fragile stock un.atomicRMDir aborts.

!macro _DevTermWriteKillScript
  FileOpen $R9 "$TEMP\devterm-nsis-kill.ps1" w
  FileWrite $R9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R9 "$$instDir = @'$\r$\n"
  FileWrite $R9 "$INSTDIR$\r$\n"
  FileWrite $R9 "'@.Trim()$\r$\n"
  FileWrite $R9 "function Get-NormalizedPath([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return '' }$\r$\n"
  FileWrite $R9 "  try {$\r$\n"
  FileWrite $R9 "    $$full = [System.IO.Path]::GetFullPath($$p)$\r$\n"
  FileWrite $R9 "    if (Test-Path -LiteralPath $$full) { $$full = (Get-Item -LiteralPath $$full).FullName }$\r$\n"
  FileWrite $R9 "    return $$full.TrimEnd('\', '/').ToLowerInvariant()$\r$\n"
  FileWrite $R9 "  } catch { return $$p.TrimEnd('\', '/').ToLowerInvariant() }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "function Test-SafeRoot([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return $$false }$\r$\n"
  FileWrite $R9 "  $$norm = Get-NormalizedPath $$p$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$norm) -or $$norm.Length -lt 8) { return $$false }$\r$\n"
  FileWrite $R9 "  $$winDir = Get-NormalizedPath $$env:SystemRoot$\r$\n"
  FileWrite $R9 "  $$progFiles = Get-NormalizedPath $$env:ProgramFiles$\r$\n"
  FileWrite $R9 "  $$progFilesX86 = Get-NormalizedPath ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))$\r$\n"
  FileWrite $R9 "  $$localAppData = Get-NormalizedPath $$env:LOCALAPPDATA$\r$\n"
  FileWrite $R9 "  $$appData = Get-NormalizedPath $$env:APPDATA$\r$\n"
  FileWrite $R9 "  $$userProfile = Get-NormalizedPath $$env:USERPROFILE$\r$\n"
  FileWrite $R9 "  $$systemDrive = Get-NormalizedPath ('{0}\' -f $$env:SystemDrive.TrimEnd('\'))$\r$\n"
  FileWrite $R9 "  $$dangerousRoots = @($$winDir, $$progFiles, $$progFilesX86, $$localAppData, $$appData, $$userProfile, $$systemDrive, 'c:', 'c:\')$\r$\n"
  FileWrite $R9 "  foreach ($$d in $$dangerousRoots) { if ($$norm -eq $$d) { return $$false } }$\r$\n"
  FileWrite $R9 "  return $$true$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "$$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
  FileWrite $R9 "foreach ($$c in @($\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:ProgramFiles 'DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),$\r$\n"
  FileWrite $R9 "  $$instDir$\r$\n"
  FileWrite $R9 ")) {$\r$\n"
  FileWrite $R9 "  if (Test-SafeRoot $$c) {$\r$\n"
  FileWrite $R9 "    $$normC = Get-NormalizedPath $$c$\r$\n"
  FileWrite $R9 "    if ($$normC -and -not $$roots.Contains($$normC)) { [void]$$roots.Add($$normC) }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "Get-Process -Name 'DevTerm', 'devterm' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R9 "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $R9 "  $$name = $$_.Name$\r$\n"
  FileWrite $R9 "  if (-not $$name -or $$name -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$ep = $$_.ExecutablePath$\r$\n"
  FileWrite $R9 "  if (-not $$ep -or $$ep -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$normEp = Get-NormalizedPath $$ep$\r$\n"
  FileWrite $R9 "  if (-not $$normEp) { return }$\r$\n"
  FileWrite $R9 "  foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "    if ($$normEp -eq $$r -or $$normEp.StartsWith(($$r + '\'))) {$\r$\n"
  FileWrite $R9 "      Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "      Start-Process -FilePath 'taskkill.exe' -ArgumentList ('/F /T /PID {0}' -f $$_.ProcessId) -WindowStyle Hidden -ErrorAction SilentlyContinue$\r$\n"
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
  FileWrite $R9 "function Get-NormalizedPath([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return '' }$\r$\n"
  FileWrite $R9 "  try {$\r$\n"
  FileWrite $R9 "    $$full = [System.IO.Path]::GetFullPath($$p)$\r$\n"
  FileWrite $R9 "    if (Test-Path -LiteralPath $$full) { $$full = (Get-Item -LiteralPath $$full).FullName }$\r$\n"
  FileWrite $R9 "    return $$full.TrimEnd('\', '/').ToLowerInvariant()$\r$\n"
  FileWrite $R9 "  } catch { return $$p.TrimEnd('\', '/').ToLowerInvariant() }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "function Test-SafeRoot([string]$$p) {$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$p)) { return $$false }$\r$\n"
  FileWrite $R9 "  $$norm = Get-NormalizedPath $$p$\r$\n"
  FileWrite $R9 "  if ([string]::IsNullOrWhiteSpace($$norm) -or $$norm.Length -lt 8) { return $$false }$\r$\n"
  FileWrite $R9 "  $$winDir = Get-NormalizedPath $$env:SystemRoot$\r$\n"
  FileWrite $R9 "  $$progFiles = Get-NormalizedPath $$env:ProgramFiles$\r$\n"
  FileWrite $R9 "  $$progFilesX86 = Get-NormalizedPath ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))$\r$\n"
  FileWrite $R9 "  $$localAppData = Get-NormalizedPath $$env:LOCALAPPDATA$\r$\n"
  FileWrite $R9 "  $$appData = Get-NormalizedPath $$env:APPDATA$\r$\n"
  FileWrite $R9 "  $$userProfile = Get-NormalizedPath $$env:USERPROFILE$\r$\n"
  FileWrite $R9 "  $$systemDrive = Get-NormalizedPath ('{0}\' -f $$env:SystemDrive.TrimEnd('\'))$\r$\n"
  FileWrite $R9 "  $$dangerousRoots = @($$winDir, $$progFiles, $$progFilesX86, $$localAppData, $$appData, $$userProfile, $$systemDrive, 'c:', 'c:\')$\r$\n"
  FileWrite $R9 "  foreach ($$d in $$dangerousRoots) { if ($$norm -eq $$d) { return $$false } }$\r$\n"
  FileWrite $R9 "  return $$true$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "$$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
  FileWrite $R9 "foreach ($$c in @($\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),$\r$\n"
  FileWrite $R9 "  (Join-Path $$env:ProgramFiles 'DevTerm'),$\r$\n"
  FileWrite $R9 "  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),$\r$\n"
  FileWrite $R9 "  $$instDir$\r$\n"
  FileWrite $R9 ")) {$\r$\n"
  FileWrite $R9 "  if (Test-SafeRoot $$c) {$\r$\n"
  FileWrite $R9 "    $$normC = Get-NormalizedPath $$c$\r$\n"
  FileWrite $R9 "    if ($$normC -and -not $$roots.Contains($$normC)) { [void]$$roots.Add($$normC) }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "Get-Process -Name 'DevTerm', 'devterm' -ErrorAction SilentlyContinue | Stop-Process -Force$\r$\n"
  FileWrite $R9 "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $R9 "  $$name = $$_.Name$\r$\n"
  FileWrite $R9 "  if (-not $$name -or $$name -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$ep = $$_.ExecutablePath$\r$\n"
  FileWrite $R9 "  if (-not $$ep -or $$ep -match '(?i)setup|uninstall') { return }$\r$\n"
  FileWrite $R9 "  $$normEp = Get-NormalizedPath $$ep$\r$\n"
  FileWrite $R9 "  if (-not $$normEp) { return }$\r$\n"
  FileWrite $R9 "  foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "    if ($$normEp -eq $$r -or $$normEp.StartsWith(($$r + '\'))) {$\r$\n"
  FileWrite $R9 "      Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "      Start-Process -FilePath 'taskkill.exe' -ArgumentList ('/F /T /PID {0}' -f $$_.ProcessId) -WindowStyle Hidden -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "      break$\r$\n"
  FileWrite $R9 "    }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "Start-Sleep -Milliseconds 400$\r$\n"
  FileWrite $R9 "foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R9 "  if (-not (Test-Path -LiteralPath $$r)) { continue }$\r$\n"
  FileWrite $R9 "  Get-ChildItem -LiteralPath $$r -Force -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $R9 "    $$item = $$_.FullName$\r$\n"
  FileWrite $R9 "    Remove-Item -LiteralPath $$item -Recurse -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "    if (Test-Path -LiteralPath $$item) {$\r$\n"
  FileWrite $R9 "      Start-Sleep -Milliseconds 200$\r$\n"
  FileWrite $R9 "      Remove-Item -LiteralPath $$item -Recurse -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R9 "    }$\r$\n"
  FileWrite $R9 "  }$\r$\n"
  FileWrite $R9 "}$\r$\n"
  FileWrite $R9 "exit 0$\r$\n"
  FileClose $R9
!macroend

!macro _DevTermKillApp
  DetailPrint "DevTerm: closing DevTerm.exe and background processes..."
  ; Exact image name only — DevTerm-*-setup.exe is NOT matched by taskkill /IM.
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  nsExec::Exec `taskkill /F /T /IM "devterm.exe"`
  Pop $0
  Sleep 150
  !insertmacro _DevTermWriteKillScript
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\devterm-nsis-kill.ps1"`
  Pop $0
  Sleep 250
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  nsExec::Exec `taskkill /F /T /IM "devterm.exe"`
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

; Override default uninstaller file removal to avoid fragile un.atomicRMDir aborts.
!macro customRemoveFiles
  !insertmacro _DevTermKillApp
  !insertmacro _DevTermWipeInstallDir
!macroend
