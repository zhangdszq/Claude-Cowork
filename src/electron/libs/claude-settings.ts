import type { ClaudeSettingsEnv } from "../types.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadUserSettings } from "./user-settings.js";

const CLAUDE_SETTINGS_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
] as const;

export function loadClaudeSettingsEnv(): ClaudeSettingsEnv {
  // First, load user settings (highest priority)
  const userSettings = loadUserSettings();
  
  // Apply user settings to process.env if set
  if (userSettings.anthropicAuthToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = userSettings.anthropicAuthToken;
    process.env.ANTHROPIC_API_KEY = userSettings.anthropicAuthToken;
  }
  if (userSettings.anthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = userSettings.anthropicBaseUrl;
  }
  if (userSettings.anthropicModel) {
    process.env.ANTHROPIC_MODEL = userSettings.anthropicModel;
  }

  // Then load ~/.claude/settings.json as fallback
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    if (parsed.env) {
      for (const [key, value] of Object.entries(parsed.env)) {
        // Only apply if not already set (user settings take priority)
        if (process.env[key] === undefined && value !== undefined && value !== null) {
          process.env[key] = String(value);
        }
      }
    }
  } catch {
    // Ignore missing or invalid settings file.
  }

  const env = {} as ClaudeSettingsEnv;
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    env[key] = process.env[key] ?? "";
  }
  return env;
}

// Reload settings (called when user updates settings)
export function reloadClaudeSettings(): ClaudeSettingsEnv {
  // Clear existing env vars to allow reload
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    delete process.env[key];
  }
  return loadClaudeSettingsEnv();
}

export let claudeCodeEnv = loadClaudeSettingsEnv();

/**
 * Determine which settingSources to pass to the Claude Agent SDK query().
 * Always includes "user" (~/.claude/settings.json) so that MCP servers
 * configured there (including built-in ones seeded by ensureBuiltinMcpServers)
 * are always available. The explicit `env` passed to query() takes priority
 * over any env vars in settings files, so the custom API key is safe.
 */
export function getSettingSources(): ("user" | "project" | "local")[] {
  return ["user", "project", "local"];
}
