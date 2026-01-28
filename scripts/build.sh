#!/bin/bash

# VK Cowork Build Script
# Builds API sidecar, CLI bundle, and packages the app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Default values
BUILD_PLATFORM="current"
BUNDLE_CLI=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-cli)
      BUNDLE_CLI=true
      shift
      ;;
    mac-arm|mac-intel|linux|windows|current)
      BUILD_PLATFORM="$1"
      shift
      ;;
    -h|--help|help)
      echo "VK Cowork Build Script"
      echo ""
      echo "Usage: ./scripts/build.sh [platform] [options]"
      echo ""
      echo "Platforms:"
      echo "  mac-arm   - Build for macOS Apple Silicon (aarch64)"
      echo "  mac-intel - Build for macOS Intel (x86_64)"
      echo "  linux     - Build for Linux x86_64"
      echo "  windows   - Build for Windows x86_64"
      echo "  current   - Build for current platform (default)"
      echo ""
      echo "Options:"
      echo "  --with-cli  Bundle Claude Code CLI with Node.js runtime"
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      exit 1
      ;;
  esac
done

log_info "Building VK Cowork for $BUILD_PLATFORM"

# Determine target triple
case "$BUILD_PLATFORM" in
  mac-arm|current)
    TARGET_TRIPLE="aarch64-apple-darwin"
    ELECTRON_PLATFORM="mac"
    ELECTRON_ARCH="arm64"
    ;;
  mac-intel)
    TARGET_TRIPLE="x86_64-apple-darwin"
    ELECTRON_PLATFORM="mac"
    ELECTRON_ARCH="x64"
    ;;
  linux)
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
    ELECTRON_PLATFORM="linux"
    ELECTRON_ARCH="x64"
    ;;
  windows)
    TARGET_TRIPLE="x86_64-pc-windows-msvc"
    ELECTRON_PLATFORM="win"
    ELECTRON_ARCH="x64"
    ;;
esac

# Step 1: Install dependencies
log_info "Installing dependencies..."
npm install

# Step 2: Build API sidecar
log_info "Building API sidecar..."
cd "$PROJECT_ROOT/src-api"

if [ ! -d "node_modules" ]; then
  npm install
fi

case "$BUILD_PLATFORM" in
  mac-arm|current)
    npm run build:binary:mac-arm
    ;;
  mac-intel)
    npm run build:binary:mac-intel
    ;;
  linux)
    npm run build:binary:linux
    ;;
  windows)
    npm run build:binary:windows
    ;;
esac

log_info "API sidecar built: src-api/dist/agent-api-$TARGET_TRIPLE"

cd "$PROJECT_ROOT"

# Step 3: Bundle CLI (optional)
if [ "$BUNDLE_CLI" = "true" ]; then
  log_info "Bundling Claude Code CLI..."
  chmod +x "$SCRIPT_DIR/bundle-cli.sh"
  "$SCRIPT_DIR/bundle-cli.sh" "$BUILD_PLATFORM"
else
  log_info "Skipping CLI bundling (use --with-cli to enable)"
fi

# Step 4: Build React app
log_info "Building React app..."
npm run build

# Step 5: Transpile Electron
log_info "Transpiling Electron..."
npm run transpile:electron

# Step 6: Package with electron-builder
log_info "Packaging application..."
electron-builder --$ELECTRON_PLATFORM --$ELECTRON_ARCH

log_info "Build completed!"
log_info "Output: dist/"
