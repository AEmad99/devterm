import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isWindowsRemotePath,
  parseWindowsRemotePath,
  resolveWindowsRelative,
  toWindowsFsPath,
  toWindowsSftpPath,
  powershellEncodedCommand,
  powershellCommand,
  windowsPowerShellInteractiveCommand,
  wrapWindowsRemoteCommand,
  wrapWindowsGitCommand
} from './windows-host'

describe('windows remote paths', () => {
  it("parses drive, SFTP, and mixed slash forms", () => {
    assert.deepEqual(parseWindowsRemotePath("C:\\Users\\x"), { drive: "C", rest: "Users\\x" })
    assert.deepEqual(parseWindowsRemotePath("C:/Users/x"), { drive: "C", rest: "Users/x" })
    assert.deepEqual(parseWindowsRemotePath("/C/Users/x"), { drive: "C", rest: "Users/x" })
    assert.deepEqual(parseWindowsRemotePath("/C:/Users/x"), { drive: "C", rest: "Users/x" })
    assert.equal(isWindowsRemotePath("/home/op"), false)
    assert.equal(isWindowsRemotePath("C:\\Users"), true)
  })

  it("converts to native FS and Win32-OpenSSH SFTP paths", () => {
    assert.equal(toWindowsFsPath("/C/Users/Administrator"), "C:\\Users\\Administrator")
    assert.equal(toWindowsFsPath("C:/Users/Administrator"), "C:\\Users\\Administrator")
    assert.equal(toWindowsSftpPath("C:\\Users\\Administrator"), "/C/Users/Administrator")
    assert.equal(toWindowsSftpPath("C:/Users/Administrator"), "/C/Users/Administrator")
    assert.equal(toWindowsSftpPath("/C:/Users/Administrator"), "/C/Users/Administrator")
  })

  it("resolves relative paths against a Windows cwd", () => {
    assert.equal(
      resolveWindowsRelative("C:\\Users\\Administrator", "Documents"),
      "C:\\Users\\Administrator\\Documents"
    )
    assert.equal(
      resolveWindowsRelative("/C/Users/Administrator", "Documents/file.txt"),
      "C:\\Users\\Administrator\\Documents\\file.txt"
    )
    assert.equal(
      resolveWindowsRelative("C:\\Users\\Administrator", "C:\\Windows"),
      "C:\\Windows"
    )
  })

  it("wraps run_command in a quote-safe PowerShell command", () => {
    const wrapped = wrapWindowsRemoteCommand("Get-Location", "C:\\Users\\Administrator")
    assert.match(wrapped, /^powershell\.exe /)
    assert.match(wrapped, /-Command /)
    const b64 = wrapped.match(/FromBase64String\('([^']+)'\)/)?.[1]
    assert.ok(b64)
    const script = Buffer.from(b64, "base64").toString("utf16le")
    assert.match(script, /Set-Location -LiteralPath/)
    assert.match(script, /Get-Location/)
    assert.match(script, /Users\\Administrator/)
  })

  it("wraps git as a PowerShell Set-Location + git", () => {
    const wrapped = wrapWindowsGitCommand("C:\\repo", "'status'")
    const b64 = wrapped.match(/FromBase64String\('([^']+)'\)/)?.[1]
    assert.ok(b64)
    const script = Buffer.from(b64, "base64").toString("utf16le")
    assert.match(script, /Set-Location -LiteralPath/)
    assert.match(script, /git /)
    assert.match(script, /status/)
  })

  it("uses the quote-safe noninteractive PowerShell wrapper", () => {
    const command = powershellCommand("Write-Output ok")
    assert.match(command, /-Command /)
    assert.doesNotMatch(command, /-EncodedCommand/)
  })

  it("keeps the legacy EncodedCommand helper available for direct callers", () => {
    const command = powershellEncodedCommand("Write-Output ok")
    assert.match(command, /-EncodedCommand /)
  })

  it("starts interactive PowerShell without typing the prompt hook into the PTY", () => {
    const setup = "function prompt { Write-Host -NoNewline 'hook' }"
    const command = windowsPowerShellInteractiveCommand(setup)
    assert.match(command, /^powershell\.exe -NoLogo -NoExit -Command /)
    assert.doesNotMatch(command, /-EncodedCommand/)
    const b64 = command.match(/FromBase64String\('([^']+)'\)/)?.[1]
    assert.ok(b64)
    assert.equal(Buffer.from(b64, "base64").toString("utf16le"), setup)
  })
})

