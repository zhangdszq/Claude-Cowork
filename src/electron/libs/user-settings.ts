import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app } from "electron";

export interface OpenAITokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;  // raw JWT from OpenID Connect
  expiresAt: number; // timestamp in ms
}

export interface UserSettings {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicModel?: string;
  // Proxy settings
  proxyEnabled?: boolean;
  proxyUrl?: string;  // e.g., http://127.0.0.1:7890 or socks5://127.0.0.1:1080
  // OpenAI Codex OAuth tokens
  openaiTokens?: OpenAITokens;
  // Webhook auth token — set to require Authorization: Bearer <token> on /webhook routes
  webhookToken?: string;
  // Personalization
  userName?: string;
  workDescription?: string;
  globalPrompt?: string;
  // Quick window global shortcut (Electron accelerator format, e.g. "Alt+Space")
  quickWindowShortcut?: string;
}

const SETTINGS_FILE = join(app.getPath("userData"), "user-settings.json");

function ensureDirectory() {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadUserSettings(): UserSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) {
      return {};
    }
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export function saveUserSettings(settings: UserSettings): void {
  ensureDirectory();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}

export function getUserSetting<K extends keyof UserSettings>(key: K): UserSettings[K] {
  const settings = loadUserSettings();
  return settings[key];
}

export function setUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
  const settings = loadUserSettings();
  settings[key] = value;
  saveUserSettings(settings);
}
