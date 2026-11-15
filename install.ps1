$ErrorActionPreference = "Stop"

$Repo = "https://github.com/noan-hbt/rbx-studio-plus.git"
$ZipUrl = "https://github.com/noan-hbt/rbx-studio-plus/archive/refs/heads/main.zip"
$InstallDir = if ($env:RBX_PLUS_DIR) { $env:RBX_PLUS_DIR } else { Join-Path $env:LOCALAPPDATA "rbx-studio-plus" }

function Fail($msg) {
  Write-Host "`n✘ $msg" -ForegroundColor Red
  throw $msg
}

# 1. Check Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail "Node.js (>= 20) is required. Install it from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS"
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Fail "Node.js >= 20 is required (found $(& node -v)). Please upgrade Node.js."
}

Write-Host "Installing rbx-studio-plus into $InstallDir ..." -ForegroundColor Cyan

# 2. Clone / update, or download archive if git is missing
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating existing repository..."
    & git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail "git pull failed in $InstallDir." }
  } else {
    if (Test-Path $InstallDir) {
      Remove-Item -Recurse -Force $InstallDir
    }
    & git clone --depth 1 $Repo $InstallDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed." }
  }
} else {
  Write-Host "git not found — downloading archive..."
  $tmpZip = Join-Path $env:TEMP "rbx-studio-plus.zip"
  $tmpExtract = Join-Path $env:TEMP "rbx-studio-plus-extract"
  Remove-Item -Recurse -Force $tmpZip, $tmpExtract -ErrorAction SilentlyContinue
  Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip
  Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Move-Item (Join-Path $tmpExtract "rbx-studio-plus-main") $InstallDir
  Remove-Item -Recurse -Force $tmpZip, $tmpExtract -ErrorAction SilentlyContinue
}

# 3. Install dependencies, build, link & register MCP clients
Push-Location $InstallDir
try {
  Write-Host "Installing npm dependencies & building..."
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }

  try {
    & npm link --silent 2>$null | Out-Null
  } catch {}

  $installArgs = @("dist/src/index.js", "install")
  if ($args.Count -gt 0) {
    $installArgs += $args
  } elseif ($env:RBX_PLUS_INSTALL_ARGS) {
    $installArgs += ($env:RBX_PLUS_INSTALL_ARGS -split "\s+" | Where-Object { $_ })
  }
  & node @installArgs
  if ($LASTEXITCODE -ne 0) { Fail "MCP registration failed." }

  Write-Host ""
  & node dist/src/index.js doctor
  Write-Host "`n✔ rbx-studio-plus installed! Restart Claude Code / Codex, then open Roblox Studio with 'Enable Studio as MCP server' turned on." -ForegroundColor Green
} finally {
  Pop-Location
}
