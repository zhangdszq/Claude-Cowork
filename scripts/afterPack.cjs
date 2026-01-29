/**
 * electron-builder afterPack hook
 * Copies cli-bundle/node_modules to the packaged app before NSIS installer is created
 */
const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const { appOutDir, electronPlatformName } = context;
  
  if (electronPlatformName !== 'win32') {
    console.log('[afterPack] Skipping non-Windows platform');
    return;
  }
  
  const projectRoot = path.resolve(__dirname, '..');
  const sourceDir = path.join(projectRoot, 'cli-bundle', 'node_modules');
  const targetDir = path.join(appOutDir, 'resources', 'cli-bundle', 'node_modules');
  
  console.log('[afterPack] Copying cli-bundle/node_modules...');
  console.log('[afterPack] Source:', sourceDir);
  console.log('[afterPack] Target:', targetDir);
  
  if (!fs.existsSync(sourceDir)) {
    console.error('[afterPack] ERROR: Source directory not found:', sourceDir);
    return;
  }
  
  // Copy recursively
  copyDirSync(sourceDir, targetDir);
  
  console.log('[afterPack] Done copying node_modules');
};

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

