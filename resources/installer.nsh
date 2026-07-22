; DevTerm custom NSIS hooks.
;
; Root cause of "DevTerm cannot be closed" on reinstall (assisted + all-users):
; stock installSection.nsh runs CHECK_APP_RUNNING only on the *outer*
; (non-elevated) process:
;
;   ${ifNot} ${UAC_IsInnerInstance}
;     !insertmacro CHECK_APP_RUNNING
;   ${endif}
;
; The elevated inner process that actually uninstalls/extracts into
; "C:\Program Files\DevTerm" never runs that check. File locks from
; DevTerm.exe / bundled agent node.exe / ConPTY children then make
; CopyFiles fail, and extractAppPackage shows the misleading
; "$(appCannotBeClosed)" dialog during the Installing page.
;
; Fix:
; 1. customInit — always runs (outer + elevated inner) and force-unlocks.
; 2. customCheckAppRunning — same unlock when stock does call it.
; 3. customUnInstallCheck* — never abort the upgrade if the old uninstaller
;    returned non-zero after we already killed lock-holders; extract overwrites.

; ---------------------------------------------------------------------------
; Shared unlock body (no labels — expanded from multiple macros / instances).
; ---------------------------------------------------------------------------
!macro _DevTermUnlockInstallDir
  DetailPrint "DevTerm: closing app and releasing install-directory locks..."

  ; Main app image — tree kill. Harmless if not running. Do NOT globally kill
  ; OpenConsole.exe / node.exe / winpty-agent.exe — those names are shared with
  ; Windows Terminal and other apps; path-based kill below is the safe net.
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  Sleep 250
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0

  ; Path-based kill: any process whose ExecutablePath is under a DevTerm
  ; install root (covers bundled agent node.exe + ConPTY helpers under
  ; app.asar.unpacked). NSIS expands $INSTDIR; $$ becomes $ for PowerShell.
  ; Avoid NSIS ${...} tokens so the preprocessor never touches PowerShell.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$ErrorActionPreference='SilentlyContinue'; $$roots=@(); foreach($$c in @((Join-Path $$env:LOCALAPPDATA 'Programs\DevTerm'),(Join-Path $$env:LOCALAPPDATA 'Programs\devterm'),(Join-Path $$env:ProgramFiles 'DevTerm'),(Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DevTerm'),'$INSTDIR')){ if($$c -and $$c.Length -gt 3){ $$roots += $$c } }; Get-CimInstance Win32_Process | ForEach-Object { $$ep=$$_.ExecutablePath; if(-not $$ep){ return }; foreach($$r in $$roots){ if($$ep.StartsWith($$r,[StringComparison]::OrdinalIgnoreCase)){ Stop-Process -Id $$_.ProcessId -Force; break } } }; Start-Sleep -Milliseconds 400; foreach($$r in $$roots){ if(-not (Test-Path -LiteralPath $$r)){ continue }; @(Join-Path $$r 'DevTerm.exe'),(Join-Path $$r 'resources\app.asar'),(Join-Path $$r 'resources\app.asar.unpacked\node_modules\node\bin\node.exe') | ForEach-Object { if(Test-Path -LiteralPath $$_){ Remove-Item -LiteralPath $$_ -Force } } }"`
  Pop $0

  Sleep 600

  ; One more hard kill after deletes (handles respawn races).
  nsExec::Exec `taskkill /F /T /IM "DevTerm.exe"`
  Pop $0
  Sleep 300
!macroend

; Runs in .onInit for BOTH the outer UI process and the elevated UAC inner
; process that actually writes to Program Files.
!macro customInit
  !insertmacro _DevTermUnlockInstallDir
!macroend

; Used when stock CHECK_APP_RUNNING runs (per-user installs / outer process).
; Must not MessageBox/Quit — always continue.
!macro customCheckAppRunning
  !insertmacro _DevTermUnlockInstallDir
!macroend

; Old uninstaller often fails while files are locked; do not abort the upgrade.
; extractAppPackage will overwrite remaining files after our unlock.
!macro customUnInstallCheck
  DetailPrint "DevTerm: ignoring old uninstaller status; continuing upgrade..."
  ClearErrors
  StrCpy $R0 0
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "DevTerm: ignoring old uninstaller status (current user); continuing upgrade..."
  ClearErrors
  StrCpy $R0 0
!macroend
