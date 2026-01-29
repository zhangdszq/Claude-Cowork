# VK Cowork CLI Bundle Script for Windows
# Bundles Claude Code CLI with Node.js runtime for isolated execution

param(
    [string]$Target = "windows"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# Determine target platform
switch ($Target) {
    "windows" {
        $NodePlatform = "win"
        $NodeArch = "x64"
        $TargetTriple = "x86_64-pc-windows-msvc"
    }
    "mac-arm" {
        $NodePlatform = "darwin"
        $NodeArch = "arm64"
        $TargetTriple = "aarch64-apple-darwin"
    }
    "mac-intel" {
        $NodePlatform = "darwin"
        $NodeArch = "x64"
        $TargetTriple = "x86_64-apple-darwin"
    }
    "linux" {
        $NodePlatform = "linux"
        $NodeArch = "x64"
        $TargetTriple = "x86_64-unknown-linux-gnu"
    }
    default {
        Write-Err "Unknown target: $Target"
        Write-Host "Usage: .\bundle-cli.ps1 [windows|mac-arm|mac-intel|linux]"
        exit 1
    }
}

Write-Info "Bundling Claude Code CLI for $Target ($TargetTriple)"

# Output directory
$OutputDir = Join-Path $ProjectRoot "cli-bundle"
if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
}
New-Item -ItemType Directory -Path $OutputDir | Out-Null

# Node.js version
$NodeVersion = "22.2.0"
$NodeFilename = "node-v$NodeVersion-$NodePlatform-$NodeArch"

if ($NodePlatform -eq "win") {
    $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeFilename.zip"
    $NodeExt = ".exe"
} else {
    $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeFilename.tar.gz"
    $NodeExt = ""
}

# Cache directory
$CacheDir = Join-Path $env:USERPROFILE ".vk-cowork\cache"
$CachedNode = Join-Path $CacheDir "$NodeFilename\node$NodeExt"
if (-not (Test-Path $CacheDir)) {
    New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
}

# Download or use cached Node.js
if (Test-Path $CachedNode) {
    Write-Info "Using cached Node.js v$NodeVersion"
    Copy-Item $CachedNode (Join-Path $OutputDir "node$NodeExt")
} else {
    Write-Info "Downloading Node.js v$NodeVersion for $NodePlatform-$NodeArch..."
    
    $TempDir = Join-Path $env:TEMP "node-download-$(Get-Random)"
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    
    try {
        if ($NodePlatform -eq "win") {
            $ZipPath = Join-Path $TempDir "node.zip"
            Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath -UseBasicParsing
            Expand-Archive -Path $ZipPath -DestinationPath $TempDir
            
            $NodeExePath = Join-Path $TempDir "$NodeFilename\node.exe"
            Copy-Item $NodeExePath (Join-Path $OutputDir "node.exe")
            
            # Cache it
            $CacheNodeDir = Join-Path $CacheDir $NodeFilename
            if (-not (Test-Path $CacheNodeDir)) {
                New-Item -ItemType Directory -Path $CacheNodeDir -Force | Out-Null
            }
            Copy-Item $NodeExePath (Join-Path $CacheNodeDir "node.exe")
            Write-Info "Node.js cached at $CacheNodeDir"
        } else {
            Write-Warn "Non-Windows platform download not supported in PowerShell, using local node..."
            $LocalNode = (Get-Command node -ErrorAction SilentlyContinue).Source
            if ($LocalNode) {
                Copy-Item $LocalNode (Join-Path $OutputDir "node$NodeExt")
            } else {
                throw "Node.js not available"
            }
        }
    } catch {
        Write-Warn "Failed to download Node.js: $_"
        Write-Warn "Trying local node..."
        $LocalNode = (Get-Command node -ErrorAction SilentlyContinue).Source
        if ($LocalNode) {
            Copy-Item $LocalNode (Join-Path $OutputDir "node$NodeExt")
        } else {
            Write-Err "Node.js not available"
            exit 1
        }
    } finally {
        if (Test-Path $TempDir) {
            Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
        }
    }
}

# Verify Node.js binary
$NodeBinary = Join-Path $OutputDir "node$NodeExt"
if (-not (Test-Path $NodeBinary)) {
    Write-Err "Node.js binary not found"
    exit 1
}

Write-Info "Node.js binary ready"

# Install Claude Code CLI
Set-Location $OutputDir
'{"name":"cli-bundle","private":true,"type":"module"}' | Out-File -FilePath "package.json" -Encoding utf8

Write-Info "Installing @anthropic-ai/claude-code..."
$NpmRegistry = if ($env:NPM_REGISTRY) { $env:NPM_REGISTRY } else { "https://registry.npmjs.org" }
npm install @anthropic-ai/claude-code --registry=$NpmRegistry

# Verify installation
$CliJs = Join-Path $OutputDir "node_modules\@anthropic-ai\claude-code\cli.js"
if (-not (Test-Path $CliJs)) {
    Write-Err "Claude Code installation failed"
    exit 1
}

Write-Info "Claude Code CLI installed successfully"

# Clean up unused platform-specific binaries to reduce size
Write-Info "Cleaning up unused platform binaries..."

$ClaudeKeep = switch ($TargetTriple) {
    "x86_64-unknown-linux-gnu" { "x64-linux" }
    "x86_64-pc-windows-msvc" { "x64-win32" }
    "x86_64-apple-darwin" { "x64-darwin" }
    "aarch64-apple-darwin" { "arm64-darwin" }
    default { "" }
}

# Clean ripgrep vendor directory
$ClaudeRgVendor = Join-Path $OutputDir "node_modules\@anthropic-ai\claude-code\vendor\ripgrep"
if ((Test-Path $ClaudeRgVendor) -and $ClaudeKeep) {
    Write-Info "Cleaning vendor/ripgrep (keeping $ClaudeKeep)..."
    Get-ChildItem -Path $ClaudeRgVendor -Directory | ForEach-Object {
        if ($_.Name -ne $ClaudeKeep) {
            Remove-Item -Recurse -Force $_.FullName
            Write-Info "  Removed ripgrep/$($_.Name)"
        }
    }
}

Write-Info "Platform cleanup completed"

# Copy .wasm files to bundle root if needed
Get-ChildItem -Path (Join-Path $OutputDir "node_modules\@anthropic-ai\claude-code") -Filter "*.wasm" -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName $OutputDir
}

Set-Location $ProjectRoot

# Create launcher script
Write-Info "Creating launcher script..."

$LauncherContent = @'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
"%SCRIPT_DIR%node.exe" "%SCRIPT_DIR%node_modules\@anthropic-ai\claude-code\cli.js" %*
'@

$LauncherContent | Out-File -FilePath (Join-Path $OutputDir "claude.cmd") -Encoding ascii

# Create target-specific launcher
if ($TargetTriple) {
    Copy-Item (Join-Path $OutputDir "claude.cmd") (Join-Path $OutputDir "claude-$TargetTriple.cmd")
    Write-Info "Created launcher: claude-$TargetTriple.cmd"
}

# Create claude.mjs for SDK compatibility (SDK uses node to execute .mjs files)
Write-Info "Creating claude.mjs for SDK compatibility..."
$MjsContent = @'
#!/usr/bin/env node
// Wrapper script for Claude Code CLI
// This file exists so the SDK will use node to execute it
import './node_modules/@anthropic-ai/claude-code/cli.js';
'@

$MjsContent | Out-File -FilePath (Join-Path $OutputDir "claude.mjs") -Encoding utf8
Write-Info "Created claude.mjs"

# Report bundle size
$BundleSize = "{0:N2} MB" -f ((Get-ChildItem -Path $OutputDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
Write-Info "CLI bundle completed!"
Write-Info "Bundle size: $BundleSize"
Write-Info "Output: $OutputDir"


