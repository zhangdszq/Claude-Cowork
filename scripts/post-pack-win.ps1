# Post-pack script for Windows
# Copies cli-bundle/node_modules to the packaged app

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SourceDir = Join-Path $ProjectRoot "cli-bundle\node_modules"
$TargetDir = Join-Path $ProjectRoot "dist\win-unpacked\resources\cli-bundle\node_modules"

if (Test-Path $SourceDir) {
    Write-Host "Copying cli-bundle/node_modules to packaged app..."
    Copy-Item -Path $SourceDir -Destination $TargetDir -Recurse -Force
    Write-Host "Done!"
} else {
    Write-Host "Warning: cli-bundle/node_modules not found at $SourceDir"
}

