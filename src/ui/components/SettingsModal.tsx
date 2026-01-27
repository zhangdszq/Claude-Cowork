import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TabValue = "api" | "proxy";

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabValue>("api");
  
  // API settings
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  
  // Proxy settings
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");
  
  // UI state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      window.electron.getUserSettings().then((settings) => {
        setBaseUrl(settings.anthropicBaseUrl ?? "");
        setAuthToken(settings.anthropicAuthToken ?? "");
        setProxyEnabled(settings.proxyEnabled ?? false);
        setProxyUrl(settings.proxyUrl ?? "");
        setSaved(false);
        setValidationError(null);
      });
    }
  }, [open]);

  const handleSave = async () => {
    setValidationError(null);
    
    // If we have custom API settings, validate them first
    const hasCustomConfig = baseUrl.trim() || authToken.trim();
    
    if (hasCustomConfig) {
      setValidating(true);
      try {
        const result = await window.electron.validateApiConfig(
          baseUrl.trim() || undefined,
          authToken.trim() || undefined
        );
        
        if (!result.valid) {
          setValidationError(result.message);
          setValidating(false);
          return;
        }
      } catch (error) {
        setValidationError("验证失败: " + (error instanceof Error ? error.message : String(error)));
        setValidating(false);
        return;
      }
      setValidating(false);
    }
    
    // Validate proxy URL format if enabled
    if (proxyEnabled && proxyUrl.trim()) {
      const proxyPattern = /^(https?|socks5?):\/\/[^\s]+$/i;
      if (!proxyPattern.test(proxyUrl.trim())) {
        setValidationError("代理地址格式无效，应为 http://host:port 或 socks5://host:port");
        return;
      }
    }
    
    // Validation passed, save settings
    setSaving(true);
    try {
      await window.electron.saveUserSettings({
        anthropicBaseUrl: baseUrl.trim() || undefined,
        anthropicAuthToken: authToken.trim() || undefined,
        proxyEnabled,
        proxyUrl: proxyUrl.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => {
        onOpenChange(false);
      }, 1000);
    } catch (error) {
      console.error("Failed to save settings:", error);
      setValidationError("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleClearApi = async () => {
    setBaseUrl("");
    setAuthToken("");
  };

  const handleClearProxy = () => {
    setProxyEnabled(false);
    setProxyUrl("");
  };

  const hasApiChanges = baseUrl.trim() !== "" || authToken.trim() !== "";
  const hasProxyChanges = proxyEnabled || proxyUrl.trim() !== "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface p-6 shadow-elevated overflow-y-auto">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-800">
              设置
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          <Tabs.Root value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)} className="mt-4">
            <Tabs.List className="flex gap-1 border-b border-ink-900/10 mb-4">
              <Tabs.Trigger
                value="api"
                className="px-4 py-2 text-sm font-medium text-muted hover:text-ink-700 border-b-2 border-transparent data-[state=active]:text-accent data-[state=active]:border-accent transition-colors"
              >
                API 设置
              </Tabs.Trigger>
              <Tabs.Trigger
                value="proxy"
                className="px-4 py-2 text-sm font-medium text-muted hover:text-ink-700 border-b-2 border-transparent data-[state=active]:text-accent data-[state=active]:border-accent transition-colors"
              >
                代理设置
              </Tabs.Trigger>
            </Tabs.List>

            {/* API Settings Tab */}
            <Tabs.Content value="api" className="outline-none">
              <p className="text-sm text-muted mb-4">
                配置 Anthropic API 访问设置
              </p>

              <div className="grid gap-4">
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted">API 地址</span>
                  <input
                    type="url"
                    className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    placeholder="https://api.anthropic.com (可选)"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-light">
                    自定义 API 端点，用于第三方兼容服务
                  </span>
                </label>

                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted">API Token</span>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 pr-12 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
                      placeholder="sk-ant-..."
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-muted hover:text-ink-700 transition-colors"
                      aria-label={showToken ? "Hide token" : "Show token"}
                    >
                      {showToken ? (
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <span className="text-[11px] text-muted-light">
                    从{" "}
                    <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      console.anthropic.com
                    </a>
                    {" "}获取 API Key
                  </span>
                </label>

                {hasApiChanges && (
                  <button
                    type="button"
                    onClick={handleClearApi}
                    className="text-left text-xs text-muted hover:text-error transition-colors"
                  >
                    清除 API 设置
                  </button>
                )}
              </div>
            </Tabs.Content>

            {/* Proxy Settings Tab */}
            <Tabs.Content value="proxy" className="outline-none">
              <p className="text-sm text-muted mb-4">
                配置网络代理，所有进程将通过此代理访问网络
              </p>

              <div className="grid gap-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={proxyEnabled}
                      onChange={(e) => setProxyEnabled(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-10 h-6 bg-ink-900/20 rounded-full peer-checked:bg-accent transition-colors" />
                    <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm peer-checked:translate-x-4 transition-transform" />
                  </div>
                  <span className="text-sm font-medium text-ink-700">启用代理</span>
                </label>

                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted">代理地址</span>
                  <input
                    type="text"
                    className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder="http://127.0.0.1:7890"
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    disabled={!proxyEnabled}
                  />
                  <span className="text-[11px] text-muted-light">
                    支持 HTTP 和 SOCKS5 代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
                  </span>
                </label>

                {hasProxyChanges && (
                  <button
                    type="button"
                    onClick={handleClearProxy}
                    className="text-left text-xs text-muted hover:text-error transition-colors"
                  >
                    清除代理设置
                  </button>
                )}

                <div className="rounded-xl border border-info/20 bg-info/5 p-3">
                  <p className="text-xs text-info">
                    <strong>说明：</strong>代理设置将应用于 Agent 执行的所有网络请求，
                    包括 API 调用和工具执行。修改后需要重启会话生效。
                  </p>
                </div>
              </div>
            </Tabs.Content>
          </Tabs.Root>

          {/* Validation Error */}
          {validationError && (
            <div className="mt-4 rounded-xl border border-error/20 bg-error/5 p-3">
              <p className="text-xs text-error flex items-start gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <span>{validationError}</span>
              </p>
            </div>
          )}

          {/* Save Button */}
          <div className="mt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={validating || saving}
              className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {validating ? (
                <span className="flex items-center justify-center gap-2">
                  <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  验证中...
                </span>
              ) : saving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  保存中...
                </span>
              ) : saved ? (
                <span className="flex items-center justify-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12l4 4L19 6" />
                  </svg>
                  已保存
                </span>
              ) : (
                "保存设置"
              )}
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-info/20 bg-info/5 p-3">
            <p className="text-xs text-info">
              <strong>注意：</strong>这里的设置优先于环境变量。修改后对新会话生效。
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
