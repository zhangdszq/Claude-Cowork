import { claudeCodeEnv } from "./claude-settings.js";
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { app } from "electron";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

// Get Claude Code CLI path for packaged app
export function getClaudeCodePath(): string | undefined {
  if (app.isPackaged) {
    // Check for bundled CLI first (Windows uses .cmd, others use no extension)
    const isWindows = process.platform === 'win32';
    const cliName = isWindows ? 'claude.cmd' : 'claude';
    const bundledCliPath = join(process.resourcesPath, 'cli-bundle', cliName);
    if (existsSync(bundledCliPath)) {
      return bundledCliPath;
    }
    // Fall back to unpacked SDK
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }
  return undefined;
}

// Build enhanced PATH for packaged environment
export function getEnhancedEnv(): Record<string, string | undefined> {
  const home = homedir();
  const isWindows = process.platform === 'win32';
  const pathSeparator = isWindows ? ';' : ':';
  
  const additionalPaths = isWindows ? [
    `${home}\\.bun\\bin`,
    `${home}\\AppData\\Roaming\\npm`,
    `${home}\\.volta\\bin`,
  ] : [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${home}/.bun/bin`,
    `${home}/.nvm/versions/node/v20.0.0/bin`,
    `${home}/.nvm/versions/node/v22.0.0/bin`,
    `${home}/.nvm/versions/node/v18.0.0/bin`,
    `${home}/.volta/bin`,
    `${home}/.fnm/aliases/default/bin`,
    '/usr/bin',
    '/bin',
  ];

  const currentPath = process.env.PATH || '';
  const newPath = [...additionalPaths, currentPath].join(pathSeparator);

  return {
    ...process.env,
    PATH: newPath,
  };
}

export const claudeCodePath = getClaudeCodePath();
export const enhancedEnv = getEnhancedEnv();

export const generateSessionTitle = async (userIntent: string | null) => {
  if (!userIntent) return "New Session";

  const result: SDKResultMessage = await unstable_v2_prompt(
    `please analynis the following user input to generate a short but clearly title to identify this conversation theme:
    ${userIntent}
    directly output the title, do not include any other content`, {
    model: claudeCodeEnv.ANTHROPIC_MODEL,
    env: enhancedEnv,
    pathToClaudeCodeExecutable: claudeCodePath,
  });

  if (result.subtype === "success") {
    return result.result;
  }


  return "New Session";
};
