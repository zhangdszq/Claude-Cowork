#!/bin/bash

# VK Cowork CLI Bundle Script
# Bundles Claude Code CLI with Node.js runtime for isolated execution

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

# Determine target platform
TARGET="${1:-current}"

case "$TARGET" in
  mac-arm|current)
    NODE_PLATFORM="darwin"
    NODE_ARCH="arm64"
    TARGET_TRIPLE="aarch64-apple-darwin"
    ;;
  mac-intel)
    NODE_PLATFORM="darwin"
    NODE_ARCH="x64"
    TARGET_TRIPLE="x86_64-apple-darwin"
    ;;
  linux)
    NODE_PLATFORM="linux"
    NODE_ARCH="x64"
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
    ;;
  windows)
    NODE_PLATFORM="win"
    NODE_ARCH="x64"
    TARGET_TRIPLE="x86_64-pc-windows-msvc"
    ;;
  *)
    log_error "Unknown target: $TARGET"
    echo "Usage: $0 [mac-arm|mac-intel|linux|windows|current]"
    exit 1
    ;;
esac

log_info "Bundling Claude Code CLI for $TARGET ($TARGET_TRIPLE)"

# Output directory
OUTPUT_DIR="$PROJECT_ROOT/cli-bundle"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Node.js version
NODE_VERSION="22.2.0"
NODE_FILENAME="node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}"

if [ "$NODE_PLATFORM" = "win" ]; then
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILENAME}.zip"
  NODE_EXT=".exe"
else
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILENAME}.tar.gz"
  NODE_EXT=""
fi

# Cache directory
CACHE_DIR="$HOME/.vk-cowork/cache"
CACHED_NODE="$CACHE_DIR/${NODE_FILENAME}/node${NODE_EXT}"
mkdir -p "$CACHE_DIR"

# Download or use cached Node.js
if [ -f "$CACHED_NODE" ]; then
  log_info "Using cached Node.js v${NODE_VERSION}"
  cp "$CACHED_NODE" "$OUTPUT_DIR/node${NODE_EXT}"
  chmod +x "$OUTPUT_DIR/node${NODE_EXT}" 2>/dev/null || true
else
  log_info "Downloading Node.js v${NODE_VERSION} for ${NODE_PLATFORM}-${NODE_ARCH}..."
  
  TEMP_DIR=$(mktemp -d)
  cd "$TEMP_DIR"
  
  DOWNLOAD_SUCCESS=false
  
  if [ "$NODE_PLATFORM" = "win" ]; then
    if curl -fsSL "$NODE_URL" -o node.zip 2>/dev/null; then
      unzip -q node.zip
      cp "${NODE_FILENAME}/node.exe" "$OUTPUT_DIR/node.exe"
      mkdir -p "$CACHE_DIR/${NODE_FILENAME}"
      cp "${NODE_FILENAME}/node.exe" "$CACHE_DIR/${NODE_FILENAME}/node.exe"
      DOWNLOAD_SUCCESS=true
    fi
  else
    if curl -fsSL "$NODE_URL" | tar xz 2>/dev/null; then
      cp "${NODE_FILENAME}/bin/node" "$OUTPUT_DIR/node"
      chmod +x "$OUTPUT_DIR/node"
      mkdir -p "$CACHE_DIR/${NODE_FILENAME}"
      cp "${NODE_FILENAME}/bin/node" "$CACHE_DIR/${NODE_FILENAME}/node"
      DOWNLOAD_SUCCESS=true
    fi
  fi
  
  cd "$PROJECT_ROOT"
  rm -rf "$TEMP_DIR"
  
  if [ "$DOWNLOAD_SUCCESS" != "true" ]; then
    log_warn "Failed to download Node.js, trying local node..."
    if command -v node &> /dev/null; then
      cp "$(which node)" "$OUTPUT_DIR/node${NODE_EXT}"
      chmod +x "$OUTPUT_DIR/node${NODE_EXT}" 2>/dev/null || true
    else
      log_error "Node.js not available"
      exit 1
    fi
  else
    log_info "Node.js cached at $CACHE_DIR/${NODE_FILENAME}/"
  fi
fi

# Verify Node.js binary
if [ ! -f "$OUTPUT_DIR/node${NODE_EXT}" ]; then
  log_error "Node.js binary not found"
  exit 1
fi

log_info "Node.js binary ready"

# Install Claude Code CLI
cd "$OUTPUT_DIR"
echo '{"name":"cli-bundle","private":true,"type":"module"}' > package.json

log_info "Installing @anthropic-ai/claude-code..."
npm install @anthropic-ai/claude-code --registry="${NPM_REGISTRY:-https://registry.npmjs.org}" 2>&1 | tail -15

# Verify installation
if [ ! -f "node_modules/@anthropic-ai/claude-code/cli.js" ]; then
  log_error "Claude Code installation failed"
  exit 1
fi

log_info "Claude Code CLI installed successfully"

# Clean up unused platform-specific binaries to reduce size
log_info "Cleaning up unused platform binaries..."

# Determine which platform dirs to keep for Claude Code
CLAUDE_KEEP=""
case "$TARGET_TRIPLE" in
  x86_64-unknown-linux-gnu)
    CLAUDE_KEEP="x64-linux"
    ;;
  x86_64-pc-windows-msvc)
    CLAUDE_KEEP="x64-win32"
    ;;
  x86_64-apple-darwin)
    CLAUDE_KEEP="x64-darwin"
    ;;
  aarch64-apple-darwin)
    CLAUDE_KEEP="arm64-darwin"
    ;;
esac

# Clean ripgrep vendor directory
CLAUDE_RG_VENDOR="node_modules/@anthropic-ai/claude-code/vendor/ripgrep"
if [ -d "$CLAUDE_RG_VENDOR" ] && [ -n "$CLAUDE_KEEP" ]; then
  log_info "Cleaning vendor/ripgrep (keeping $CLAUDE_KEEP)..."
  for item in "$CLAUDE_RG_VENDOR"/*; do
    itemname=$(basename "$item")
    if [ -d "$item" ] && [ "$itemname" != "$CLAUDE_KEEP" ]; then
      rm -rf "$item"
      log_info "  Removed ripgrep/$itemname"
    fi
  done
fi

log_info "Platform cleanup completed"

# Copy .wasm files to bundle root if needed
cp node_modules/@anthropic-ai/claude-code/*.wasm . 2>/dev/null || true

cd "$PROJECT_ROOT"

# Create launcher script
log_info "Creating launcher script..."

if [ "$NODE_PLATFORM" = "win" ]; then
  cat > "$OUTPUT_DIR/claude.cmd" << 'BATCH_EOF'
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
"%SCRIPT_DIR%node.exe" "%SCRIPT_DIR%node_modules\@anthropic-ai\claude-code\cli.js" %*
BATCH_EOF
else
  cat > "$OUTPUT_DIR/claude" << 'SHELL_EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/node" "$SCRIPT_DIR/node_modules/@anthropic-ai/claude-code/cli.js" "$@"
SHELL_EOF
  chmod +x "$OUTPUT_DIR/claude"
fi

# Create target-specific launcher
if [ -n "$TARGET_TRIPLE" ]; then
  if [ "$NODE_PLATFORM" = "win" ]; then
    cp "$OUTPUT_DIR/claude.cmd" "$OUTPUT_DIR/claude-$TARGET_TRIPLE.cmd"
  else
    cp "$OUTPUT_DIR/claude" "$OUTPUT_DIR/claude-$TARGET_TRIPLE"
    chmod +x "$OUTPUT_DIR/claude-$TARGET_TRIPLE"
  fi
  log_info "Created launcher: claude-$TARGET_TRIPLE"
fi

# Report bundle size
BUNDLE_SIZE=$(du -sh "$OUTPUT_DIR" 2>/dev/null | cut -f1)
log_info "CLI bundle completed!"
log_info "Bundle size: $BUNDLE_SIZE"
log_info "Output: $OUTPUT_DIR"
