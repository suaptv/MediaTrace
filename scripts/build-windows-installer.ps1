param(
  [ValidateSet("x64", "arm64")][string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Package = Get-Content (Join-Path $ProjectDir "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$Rid = if ($Architecture -eq "arm64") { "win-arm64" } else { "win-x64" }
$StageRoot = Join-Path $ProjectDir "dist\windows\staging-$Architecture"
$ExtensionStage = Join-Path $StageRoot "Extension"
$HostStage = Join-Path $StageRoot "NativeHost"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "The release builder requires .NET 8 SDK 8.0.100 or later. End users do not need it."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "The release builder requires Node.js 18 or later. End users do not need it."
}

$IsccCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
)
$Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Iscc) { throw "Inno Setup 6.3 or later was not found. Install it from https://jrsoftware.org/isdl.php" }

& node (Join-Path $ProjectDir "scripts\prepare-chromium-background.mjs")
if ($LASTEXITCODE -ne 0) { throw "Chromium background generation failed." }

if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Force $ExtensionStage, $HostStage | Out-Null
Copy-Item (Join-Path $ProjectDir "manifest.json") $ExtensionStage
Copy-Item (Join-Path $ProjectDir "assets") $ExtensionStage -Recurse
Copy-Item (Join-Path $ProjectDir "src") $ExtensionStage -Recurse

& dotnet publish (Join-Path $ProjectDir "native-host-windows\MediaTrace.NativeHost.csproj") `
  -c Release -r $Rid -o $HostStage --self-contained true /p:PublishSingleFile=true /p:DebugType=None /p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "Windows Native Host publish failed for $Rid." }

$Iss = Join-Path $ProjectDir "installer\windows\MediaTrace.iss"
& $Iscc "/DSourceRoot=$ProjectDir" "/DStageRoot=$StageRoot" "/DAppVersion=$Version" "/DTargetArch=$Architecture" $Iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }

Write-Host "Windows installer created:"
Write-Host (Join-Path $ProjectDir "dist\windows\MediaTrace-Setup-$Version-$Architecture.exe")

