import { loadUserSettings } from "./user-settings.js";
import { claudeCodeEnv } from "./claude-settings.js";

export type EnvironmentCheck = {
  id: string;
  name: string;
  status: "ok" | "warning" | "error" | "checking";
  message: string;
};

export type EnvironmentCheckResult = {
  checks: EnvironmentCheck[];
  allPassed: boolean;
};

/**
 * Check if API Token is configured
 */
function checkApiToken(): EnvironmentCheck {
  const userSettings = loadUserSettings();
  const hasUserToken = !!userSettings.anthropicAuthToken;
  const hasEnvToken = !!claudeCodeEnv.ANTHROPIC_AUTH_TOKEN;

  if (hasUserToken) {
    return {
      id: "api-token",
      name: "API Token",
      status: "ok",
      message: "已在应用设置中配置",
    };
  }

  if (hasEnvToken) {
    return {
      id: "api-token",
      name: "API Token",
      status: "ok",
      message: "已在环境变量中配置",
    };
  }

  return {
    id: "api-token",
    name: "API Token",
    status: "error",
    message: "未配置 API Token，请在设置中配置",
  };
}

/**
 * Check if Base URL is configured (optional)
 */
function checkBaseUrl(): EnvironmentCheck {
  const userSettings = loadUserSettings();
  const hasUserBaseUrl = !!userSettings.anthropicBaseUrl;
  const hasEnvBaseUrl = !!claudeCodeEnv.ANTHROPIC_BASE_URL;

  if (hasUserBaseUrl) {
    return {
      id: "base-url",
      name: "API Base URL",
      status: "ok",
      message: `自定义: ${userSettings.anthropicBaseUrl}`,
    };
  }

  if (hasEnvBaseUrl) {
    return {
      id: "base-url",
      name: "API Base URL",
      status: "ok",
      message: `自定义: ${claudeCodeEnv.ANTHROPIC_BASE_URL}`,
    };
  }

  return {
    id: "base-url",
    name: "API Base URL",
    status: "ok",
    message: "使用官方 API",
  };
}

/**
 * Run all environment checks
 */
export async function runEnvironmentChecks(): Promise<EnvironmentCheckResult> {
  const checks: EnvironmentCheck[] = [
    checkApiToken(),
    checkBaseUrl(),
  ];

  const allPassed = checks.every(
    (check) => check.status === "ok" || check.status === "warning"
  );

  return {
    checks,
    allPassed,
  };
}

/**
 * Validate API configuration by making a test request
 */
export type ValidateApiResult = {
  valid: boolean;
  message: string;
};

export async function validateApiConfig(
  baseUrl?: string,
  authToken?: string,
  model?: string
): Promise<ValidateApiResult> {
  const url = (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/$/, "");
  const token = authToken?.trim() || claudeCodeEnv.ANTHROPIC_AUTH_TOKEN;
  const modelId = model?.trim() || "claude-sonnet-4-20250514";

  if (!token) {
    return { valid: false, message: "API Token 是必需的" };
  }

  try {
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // 200 = success, 400 = bad request but auth passed
    if (response.ok || response.status === 400) {
      return { valid: true, message: "连接成功" };
    }

    // 401/403 = auth failed
    if (response.status === 401 || response.status === 403) {
      return { valid: false, message: "认证失败: API Token 无效" };
    }

    // Other errors
    const errorText = await response.text().catch(() => "");
    return { valid: false, message: `API 错误 (${response.status}): ${errorText.slice(0, 100)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, message: `连接失败: ${message}` };
  }
}
