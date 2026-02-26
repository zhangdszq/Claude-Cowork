import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadUserSettings } from "./user-settings.js";

export type AssistantConfig = {
  id: string;
  name: string;
  provider: "claude" | "codex";
  model?: string;
  skillNames?: string[];
  skillTags?: string[];
  persona?: string;
  defaultCwd?: string;
  bots?: Record<string, unknown>;
};

export type AssistantsConfig = {
  assistants: AssistantConfig[];
  defaultAssistantId?: string;
};

const VK_COWORK_DIR = join(homedir(), ".vk-cowork");
const ASSISTANTS_FILE = join(VK_COWORK_DIR, "assistants-config.json");

/**
 * Determine which provider to use for the default assistant based on what has
 * been configured.  Codex takes priority when both are available.
 *
 * - Codex:  openaiTokens in user-settings  OR  ~/.codex/auth.json exists
 * - Claude: anthropicAuthToken in user-settings  OR  ANTHROPIC_AUTH_TOKEN env var
 *
 * Falls back to "claude" when neither is configured.
 */
function resolveDefaultProvider(): "claude" | "codex" {
  const settings = loadUserSettings();

  const hasCodex =
    !!settings.openaiTokens?.accessToken ||
    existsSync(join(homedir(), ".codex", "auth.json"));

  const hasClaude =
    !!settings.anthropicAuthToken ||
    !!process.env.ANTHROPIC_AUTH_TOKEN;

  if (hasCodex) return "codex";
  if (hasClaude) return "claude";
  return "claude";
}

function buildDefaultAssistants(): AssistantConfig[] {
  return [
    {
      id: "default-assistant",
      name: "小助理",
      provider: resolveDefaultProvider(),
      skillNames: [],
      persona: "你是一个通用小助理，乐于帮忙，回答简洁实用。",
    },
  ];
}

function buildDefaultConfig(): AssistantsConfig {
  const assistants = buildDefaultAssistants();
  return {
    assistants,
    defaultAssistantId: assistants[0]?.id,
  };
}

function ensureDirectory() {
  if (!existsSync(VK_COWORK_DIR)) {
    mkdirSync(VK_COWORK_DIR, { recursive: true });
  }
}

function normalizeConfig(input?: Partial<AssistantsConfig> | null): AssistantsConfig {
  const rawAssistants = Array.isArray(input?.assistants) ? input.assistants : [];
  const assistants = rawAssistants
    .filter((item): item is AssistantConfig => Boolean(item?.id && item?.name && item?.provider))
    .map<AssistantConfig>((item) => ({
      id: String(item.id),
      name: String(item.name),
      provider: item.provider === "codex" ? "codex" : "claude",
      model: item.model ? String(item.model) : undefined,
      skillNames: Array.isArray(item.skillNames)
        ? item.skillNames.filter(Boolean).map((name) => String(name))
        : [],
      skillTags: Array.isArray(item.skillTags)
        ? item.skillTags.filter(Boolean).map((tag) => String(tag))
        : undefined,
      persona: item.persona ? String(item.persona) : undefined,
      bots: item.bots && typeof item.bots === "object" ? item.bots : undefined,
    }));

  if (assistants.length === 0) {
    const defaultConfig = buildDefaultConfig();
    return defaultConfig;
  }

  const preferredDefault = input?.defaultAssistantId;
  const defaultExists = preferredDefault && assistants.some((item) => item.id === preferredDefault);

  return {
    assistants,
    defaultAssistantId: defaultExists ? preferredDefault : assistants[0]?.id,
  };
}

export function loadAssistantsConfig(): AssistantsConfig {
  try {
    if (!existsSync(ASSISTANTS_FILE)) {
      const defaultConfig = buildDefaultConfig();
      saveAssistantsConfig(defaultConfig);
      return defaultConfig;
    }
    const raw = readFileSync(ASSISTANTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AssistantsConfig>;
    const normalized = normalizeConfig(parsed);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      saveAssistantsConfig(normalized);
    }
    return normalized;
  } catch {
    return buildDefaultConfig();
  }
}

export function saveAssistantsConfig(config: AssistantsConfig): AssistantsConfig {
  const normalized = normalizeConfig(config);
  ensureDirectory();
  writeFileSync(ASSISTANTS_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}
