param(
  [string]$NativeId = "app.mediatrace",
  [switch]$RemoveIdentity
)

$ErrorActionPreference = "Stop"
$MediaTraceRoot = Join-Path $env:LOCALAPPDATA "MediaTrace"
$InstallDir = Join-Path $MediaTraceRoot "NativeHost"
$IdentityKey = Join-Path $MediaTraceRoot "mediatrace.pem"
$BrowserRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
)

# A browser that has not fully exited may leave the stdio host alive.
Get-Process -Name "mediatrace-native-host" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

$RemovedRegistrations = @()
foreach ($BrowserRoot in $BrowserRoots) {
  if (-not (Test-Path $BrowserRoot)) { continue }
  foreach ($Registration in Get-ChildItem $BrowserRoot -ErrorAction SilentlyContinue) {
    $ManifestPath = [string](Get-Item $Registration.PSPath).GetValue("")
    $IsRequestedId = $Registration.PSChildName -eq $NativeId
    $IsMediaTraceManifest = $false
    if ($ManifestPath -and (Test-Path $ManifestPath)) {
      try {
        $ManifestText = Get-Content $ManifestPath -Raw
        $IsMediaTraceManifest = $ManifestPath.StartsWith($MediaTraceRoot, [StringComparison]::OrdinalIgnoreCase) `
          -and ($ManifestText -match 'MediaTrace|mediatrace-native-host')
      } catch { $IsMediaTraceManifest = $false }
    } elseif ($ManifestPath) {
      $IsMediaTraceManifest = $ManifestPath.StartsWith($MediaTraceRoot, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($IsRequestedId -or $IsMediaTraceManifest) {
      Remove-Item $Registration.PSPath -Recurse -Force
      $RemovedRegistrations += $Registration.PSChildName
    }
  }
}

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
if ($RemoveIdentity -and (Test-Path $IdentityKey)) { Remove-Item $IdentityKey -Force }

Write-Host "MediaTrace Windows Native Host removed."
$UniqueRegistrations = @($RemovedRegistrations | Select-Object -Unique | Sort-Object)
if ($UniqueRegistrations.Count) {
  Write-Host "Removed registrations: $($UniqueRegistrations -join ', ')"
} else {
  Write-Host "No MediaTrace Native Messaging registrations were found."
}
if ($RemoveIdentity) {
  Write-Host "Identity key removed. A future installation will use a new extension ID."
} else {
  Write-Host "Identity key preserved: $IdentityKey"
  Write-Host "Use -RemoveIdentity only if you do not need to preserve the extension ID."
}
Write-Host "Remove MediaTrace from chrome://extensions or edge://extensions, then fully restart the browser."

