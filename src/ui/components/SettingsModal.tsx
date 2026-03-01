import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowSplash?: () => void;
}

type SectionId = "personalize" | "api" | "proxy" | "openai" | "memory" | "shortcut" | "debug";

interface NavItem {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "personalize",
    label: "个性化",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "api",
    label: "API 设置",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    ),
  },
  {
    id: "proxy",
    label: "代理设置",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: "openai",
    label: "OpenAI Codex",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "记忆",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: "shortcut",
    label: "快捷键",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h4M14 8h4M8 12h8M10 16h4" />
      </svg>
    ),
  },
  {
    id: "debug",
    label: "调试",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v8a6 6 0 0 0 12 0v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />
        <path d="M9 14h6M9 18h6M2 10h4M18 10h4M2 14h4M18 14h4" />
      </svg>
    ),
  },
];

export function SettingsModal({ open, onOpenChange, onShowSplash }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("personalize");

  // Personalization
  const [userName, setUserName] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [userContext, setUserContext] = useState("");

  // API settings
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [modelName, setModelName] = useState("claude-opus-4-6-thinking");
  const [showToken, setShowToken] = useState(false);

  // Proxy settings
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");

  // OpenAI Codex auth state
  const [openaiLoggedIn, setOpenaiLoggedIn] = useState(false);
  const [openaiEmail, setOpenaiEmail] = useState<string | undefined>();
  const [openaiExpiresAt, setOpenaiExpiresAt] = useState<number | undefined>();
  const [openaiLoggingIn, setOpenaiLoggingIn] = useState(false);
  const [openaiError, setOpenaiError] = useState<string | null>(null);

  // Memory state
  const [memoryDir, setMemoryDir] = useState("");

  // Shortcut state
  const [quickShortcut, setQuickShortcut] = useState("Alt+Space");
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [shortcutSaved, setShortcutSaved] = useState(false);

  // UI state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const loadOpenAIStatus = async () => {
    try {
      const status = await window.electron.openaiAuthStatus();
      setOpenaiLoggedIn(status.loggedIn);
      setOpenaiEmail(status.email);
      setOpenaiExpiresAt(status.expiresAt);
    } catch {
      // Ignore
    }
  };

  const loadMemoryDir = async () => {
    try {
      const list = await window.electron.memoryList();
      setMemoryDir(list.memoryDir);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    if (open) {
      window.electron.getUserSettings().then((settings) => {
        setUserName(settings.userName ?? "");
        setWorkDescription(settings.workDescription ?? "");
        setGlobalPrompt(settings.globalPrompt ?? "");
        setBaseUrl(settings.anthropicBaseUrl ?? "");
        setAuthToken(settings.anthropicAuthToken ?? "");
        setModelName(settings.anthropicModel ?? "claude-opus-4-6-thinking");
        setProxyEnabled(settings.proxyEnabled ?? false);
        setProxyUrl(settings.proxyUrl ?? "");
        setSaved(false);
        setValidationError(null);
      });
      window.electron.getAssistantsConfig().then((config) => {
        setUserContext(config.userContext ?? "");
      });
      loadOpenAIStatus();
      loadMemoryDir();
      setOpenaiError(null);
      window.electron.getQuickWindowShortcut().then(setQuickShortcut).catch(() => {});
      setShortcutSaved(false);
    }
  }, [open]);

  const handleSave = async () => {
    setValidationError(null);

    if (activeSection === "api") {
      const hasCustomConfig = baseUrl.trim() || authToken.trim();
      if (hasCustomConfig) {
        setValidating(true);
        try {
          const result = await window.electron.validateApiConfig(
            baseUrl.trim() || undefined,
            authToken.trim() || undefined,
            modelName.trim() || undefined
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
    }

    if (activeSection === "proxy" && proxyEnabled && proxyUrl.trim()) {
      const proxyPattern = /^(https?|socks5?):\/\/[^\s]+$/i;
      if (!proxyPattern.test(proxyUrl.trim())) {
        setValidationError("代理地址格式无效，应为 http://host:port 或 socks5://host:port");
        return;
      }
    }

    setSaving(true);
    try {
      if (activeSection === "shortcut") {
        await window.electron.saveQuickWindowShortcut(quickShortcut);
        setShortcutSaved(true);
        setTimeout(() => setShortcutSaved(false), 2000);
      } else {
        await window.electron.saveUserSettings({
          anthropicBaseUrl: baseUrl.trim() || undefined,
          anthropicAuthToken: authToken.trim() || undefined,
          anthropicModel: modelName.trim() || undefined,
          proxyEnabled,
          proxyUrl: proxyUrl.trim() || undefined,
          userName: userName.trim(),
          workDescription: workDescription.trim(),
          globalPrompt: globalPrompt.trim(),
        });
        if (activeSection === "personalize") {
          const assistantsConfig = await window.electron.getAssistantsConfig();
          await window.electron.saveAssistantsConfig({
            ...assistantsConfig,
            userContext: userContext.trim() || undefined,
          });
        }
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save settings:", error);
      setValidationError("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleClearApi = () => {
    setBaseUrl("");
    setAuthToken("");
  };

  const handleClearProxy = () => {
    setProxyEnabled(false);
    setProxyUrl("");
  };

  const hasApiChanges = baseUrl.trim() !== "" || authToken.trim() !== "";
  const hasProxyChanges = proxyEnabled || proxyUrl.trim() !== "";
  const showSaveButton = activeSection === "personalize" || activeSection === "api" || activeSection === "proxy" || activeSection === "shortcut";

  const currentNavItem = NAV_ITEMS.find((item) => item.id === activeSection);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/25 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[780px] h-[560px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/8 shadow-elevated overflow-hidden flex flex-col" style={{ fontFamily: '"Söhne", ui-sans-serif, system-ui, -apple-system, sans-serif', background: '#F6F4F0' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-ink-900/8 flex-shrink-0">
            <Dialog.Title className="text-[15px] font-semibold text-ink-900 tracking-tight">
              {currentNavItem?.label ?? "设置"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-full p-1.5 text-ink-400 hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Body: sidebar + content */}
          <div className="flex flex-1 overflow-hidden">

            {/* Left sidebar */}
            <nav className="w-[192px] border-r border-ink-900/8 flex-shrink-0 overflow-y-auto py-3 px-2.5" style={{ background: '#F6F4F0' }}>
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveSection(item.id);
                    setValidationError(null);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-[13px] transition-all text-left mb-0.5 ${
                    activeSection === item.id
                      ? "font-medium text-white"
                      : "text-ink-600 hover:bg-black/5 hover:text-ink-900"
                  }`}
                  style={activeSection === item.id ? { background: '#2C5F2F' } : {}}
                >
                  <span className={activeSection === item.id ? "text-white/80" : "text-ink-400"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Right content area */}
            <main className="flex-1 overflow-y-auto px-6 py-5" style={{ background: '#F6F4F0' }}>

              {/* Personalization */}
              {activeSection === "personalize" && (
                <div className="grid gap-5">
                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-medium text-ink-800">姓名</span>
                    <span className="text-[11px] text-muted-light">让 AI 知道你是谁</span>
                    <input
                      type="text"
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="输入你的名字"
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-medium text-ink-800">工作描述</span>
                    <span className="text-[11px] text-muted-light">帮助 AI 理解你的背景，以便提供更贴合的回答</span>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors resize-none"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="例如：我是一名前端工程师，主要使用 React 和 TypeScript 开发 Web 应用"
                      rows={3}
                      value={workDescription}
                      onChange={(e) => setWorkDescription(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-medium text-ink-800">全局提示词</span>
                    <span className="text-[11px] text-muted-light">自定义指令会附加到每次对话的系统提示词中</span>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors resize-none"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="给 AI 的自定义指令，例如：请用中文回答，代码注释用英文"
                      rows={5}
                      value={globalPrompt}
                      onChange={(e) => setGlobalPrompt(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-1.5">
                    <span className="text-[13px] font-medium text-ink-800">关于我</span>
                    <span className="text-[11px] text-muted-light">所有助理共享的用户信息，注入到每次对话中</span>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors resize-none"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="所有助理共享的用户信息：姓名、时区、工作领域、沟通偏好等"
                      rows={4}
                      value={userContext}
                      onChange={(e) => setUserContext(e.target.value)}
                    />
                  </label>
                </div>
              )}

              {/* API Settings */}
              {activeSection === "api" && (
                <div className="grid gap-4">
                  <p className="text-[13px] text-muted">配置 Anthropic API 访问设置</p>

                  <label className="grid gap-1.5">
                    <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide">API 地址</span>
                    <input
                      type="url"
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors"
                      style={{ '--tw-ring-color': '#2C5F2F' } as React.CSSProperties}
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="https://api.anthropic.com (可选)"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                    <span className="text-[11px] text-muted-light">
                      自定义 API 端点，用于第三方兼容服务
                    </span>
                  </label>

                  <label className="grid gap-1.5">
                    <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide">API Token</span>
                    <div className="relative">
                      <input
                        type={showToken ? "text" : "password"}
                        className="w-full rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 pr-12 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors font-mono"
                        onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                        onBlur={(e) => e.currentTarget.style.borderColor = ''}
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
                      <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: '#2C5F2F' }}>
                        console.anthropic.com
                      </a>
                      {" "}获取 API Key
                    </span>
                  </label>

                  <label className="grid gap-1.5">
                    <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide">模型</span>
                    <input
                      type="text"
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors font-mono"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="claude-opus-4-6-thinking"
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                    />
                    <span className="text-[11px] text-muted-light">
                      Claude 模型名称，如 claude-opus-4-6-thinking、claude-sonnet-4-20250514 等
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

                  <div className="rounded-xl border border-info/20 bg-info/5 p-3">
                    <p className="text-xs text-info">
                      <strong>注意：</strong>这里的设置优先于环境变量。修改后对新会话生效。
                    </p>
                  </div>
                </div>
              )}

              {/* Proxy Settings */}
              {activeSection === "proxy" && (
                <div className="grid gap-4">
                  <p className="text-[13px] text-muted">配置网络代理，所有进程将通过此代理访问网络</p>

                  <div className="flex items-center justify-between py-1">
                    <span className="text-[13px] font-medium text-ink-800">代理服务器</span>
                    <label className="relative cursor-pointer">
                      <input
                        type="checkbox"
                        checked={proxyEnabled}
                        onChange={(e) => setProxyEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-6 rounded-full transition-colors" style={{ background: proxyEnabled ? '#2C5F2F' : 'rgba(26,25,21,0.2)' }} />
                      <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform" style={{ transform: proxyEnabled ? 'translateX(16px)' : 'translateX(0)' }} />
                    </label>
                  </div>

                  <label className="grid gap-1.5">
                    <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide">代理地址</span>
                    <input
                      type="text"
                      className="rounded-xl border border-ink-900/10 bg-white/70 px-4 py-2.5 text-[13px] text-ink-800 placeholder:text-muted-light focus:outline-none transition-colors font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                      onFocus={(e) => e.currentTarget.style.borderColor = '#2C5F2F'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
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
              )}

              {/* OpenAI Codex */}
              {activeSection === "openai" && (
                <div className="grid gap-4">
                  <p className="text-sm text-muted">
                    使用 ChatGPT 账号登录 OpenAI Codex，通过订阅访问 Codex 模型
                  </p>

                  {openaiLoggedIn ? (
                    <>
                      <div className="rounded-xl border border-success/20 bg-success/5 p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 flex-shrink-0">
                            <svg viewBox="0 0 24 24" className="h-5 w-5 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M5 12l4 4L19 6" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-ink-800">已登录 OpenAI</p>
                            {openaiEmail && (
                              <p className="text-xs text-muted truncate">{openaiEmail}</p>
                            )}
                            {openaiExpiresAt && (
                              <p className="text-[11px] text-muted-light mt-0.5">
                                Token 过期时间: {new Date(openaiExpiresAt).toLocaleString("zh-CN")}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={async () => {
                          await window.electron.openaiLogout();
                          setOpenaiLoggedIn(false);
                          setOpenaiEmail(undefined);
                          setOpenaiExpiresAt(undefined);
                        }}
                        className="w-full rounded-xl border border-error/20 bg-surface px-4 py-2.5 text-sm font-medium text-error hover:bg-error/5 transition-colors"
                      >
                        退出登录
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="rounded-xl border border-ink-900/10 bg-white/70 p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-900/5 flex-shrink-0">
                            <svg viewBox="0 0 24 24" className="h-5 w-5 text-ink-700" fill="currentColor">
                              <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                            </svg>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-ink-800">ChatGPT 登录</p>
                            <p className="text-[11px] text-muted-light">使用 ChatGPT Plus/Pro 订阅访问 Codex 模型</p>
                          </div>
                        </div>
                        <p className="text-xs text-muted leading-relaxed">
                          通过 ChatGPT 账号授权登录，使用您的 Plus/Pro 订阅额度访问 OpenAI Codex 模型，无需额外的 API 费用。
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={async () => {
                          setOpenaiLoggingIn(true);
                          setOpenaiError(null);
                          try {
                            const result = await window.electron.openaiLogin();
                            if (result.success) {
                              setOpenaiLoggedIn(true);
                              setOpenaiEmail(result.email);
                              await loadOpenAIStatus();
                            } else {
                              setOpenaiError(result.error || "登录失败");
                            }
                          } catch (err) {
                            setOpenaiError("登录过程出错: " + (err instanceof Error ? err.message : String(err)));
                          } finally {
                            setOpenaiLoggingIn(false);
                          }
                        }}
                        disabled={openaiLoggingIn}
                        className="w-full rounded-xl px-4 py-2.5 text-[13px] font-medium text-white shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: '#10a37f' }}
                      >
                        {openaiLoggingIn ? (
                          <span className="flex items-center justify-center gap-2">
                            <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                            正在打开登录窗口...
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-2">
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                              <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                            </svg>
                            使用 ChatGPT 登录
                          </span>
                        )}
                      </button>

                      {openaiError && (
                        <div className="rounded-xl border border-error/20 bg-error/5 p-3">
                          <p className="text-xs text-error flex items-start gap-2">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="15" y1="9" x2="9" y2="15" />
                              <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            <span>{openaiError}</span>
                          </p>
                        </div>
                      )}

                      <div className="rounded-xl border border-info/20 bg-info/5 p-3">
                        <p className="text-xs text-info leading-relaxed">
                          <strong>说明：</strong>此功能使用与 OpenAI Codex CLI 相同的 OAuth 认证流程。
                          需要有效的 ChatGPT Plus 或 Pro 订阅。登录后，Token 会自动刷新。
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Memory */}
              {activeSection === "memory" && (
                <div className="grid gap-4">
                  <p className="text-sm text-muted">
                    Agent 在新会话启动时会自动加载记忆，并在对话中主动记录重要信息
                  </p>

                  <div className="rounded-xl border border-ink-900/10 bg-white/70 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink-800">记忆目录</p>
                        {memoryDir && (
                          <p className="text-[11px] text-muted-light font-mono truncate">{memoryDir}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        let dir = memoryDir;
                        if (!dir) {
                          try {
                            const list = await window.electron.memoryList();
                            dir = list.memoryDir;
                            setMemoryDir(dir);
                          } catch { return; }
                        }
                        if (dir) window.electron.openPath(dir);
                      }}
                      className="w-full rounded-xl px-4 py-2.5 text-[13px] font-medium text-white shadow-soft transition-colors"
                      style={{ background: '#2C5F2F' }}
                    >
                      打开记忆目录
                    </button>
                  </div>

                  <div className="rounded-xl border border-info/20 bg-info/5 p-3">
                    <p className="text-xs text-info leading-relaxed">
                      <strong>说明：</strong>记忆目录包含 MEMORY.md（长期记忆）和 daily/ 文件夹（每日记忆），
                      可直接用编辑器查看和修改。
                    </p>
                  </div>
                </div>
              )}

              {/* Shortcut Settings */}
              {activeSection === "shortcut" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-muted">配置全局快捷键，快速唤起 AI 快捷对话窗口</p>

                  <div className="rounded-xl border border-ink-900/10 bg-white/70 p-4">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-ink-800">快捷工作窗口</p>
                        <p className="text-[11px] text-muted-light">随时按下快捷键即可唤起一个轻量对话窗口</p>
                      </div>
                    </div>

                    <label className="grid gap-2">
                      <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide">唤起快捷键</span>
                      <div
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (!isRecordingShortcut) return;
                          e.preventDefault();
                          e.stopPropagation();

                          const parts: string[] = [];
                          if (e.ctrlKey) parts.push("Ctrl");
                          if (e.altKey) parts.push("Alt");
                          if (e.shiftKey) parts.push("Shift");
                          if (e.metaKey) parts.push("Meta");

                          const key = e.key;
                          const ignoredKeys = new Set(["Control", "Alt", "Shift", "Meta"]);
                          if (!ignoredKeys.has(key)) {
                            let keyName = key;
                            if (key === " ") keyName = "Space";
                            else if (key.length === 1) keyName = key.toUpperCase();
                            parts.push(keyName);

                            setQuickShortcut(parts.join("+"));
                            setIsRecordingShortcut(false);
                          }
                        }}
                        onBlur={() => setIsRecordingShortcut(false)}
                        className={`flex items-center justify-between rounded-xl border px-4 py-3 text-[13px] cursor-pointer transition-all ${
                          isRecordingShortcut
                            ? "border-accent bg-accent/5 ring-2 ring-accent/20"
                            : "border-ink-900/10 bg-white/70 hover:border-ink-900/20"
                        }`}
                        onClick={() => setIsRecordingShortcut(true)}
                      >
                        <div className="flex items-center gap-2">
                          {isRecordingShortcut ? (
                            <span className="text-accent font-medium animate-pulse">请按下快捷键组合...</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              {quickShortcut.split("+").map((key, i) => (
                                <span key={i}>
                                  {i > 0 && <span className="text-muted-light mx-0.5">+</span>}
                                  <kbd className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-md border border-ink-900/15 bg-surface-secondary px-1.5 text-[11px] font-medium text-ink-700 shadow-sm">
                                    {key}
                                  </kbd>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsRecordingShortcut(!isRecordingShortcut);
                          }}
                          className="text-[11px] font-medium text-accent hover:text-accent-hover transition-colors"
                        >
                          {isRecordingShortcut ? "取消" : "修改"}
                        </button>
                      </div>
                    </label>

                    {shortcutSaved && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-success">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12l4 4L19 6" />
                        </svg>
                        快捷键已更新
                      </div>
                    )}
                  </div>

                  {/* Preset shortcuts */}
                  <div>
                    <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wide block mb-2">常用快捷键</span>
                    <div className="flex flex-wrap gap-2">
                      {["Alt+Space", "Ctrl+Space", "Ctrl+Shift+K", "Ctrl+Alt+N", "Alt+Q"].map((preset) => (
                        <button
                          key={preset}
                          onClick={() => {
                            setQuickShortcut(preset);
                            setIsRecordingShortcut(false);
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                            quickShortcut === preset
                              ? "border-accent/30 bg-accent/8 text-accent"
                              : "border-ink-900/10 bg-white/70 text-ink-600 hover:bg-surface-secondary hover:text-ink-800"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-info/20 bg-info/5 p-3">
                    <p className="text-xs text-info leading-relaxed">
                      <strong>说明：</strong>全局快捷键在应用后台运行时也能使用。
                      如果快捷键与其他应用冲突，请更换为其他组合键。
                      修改后请点击"保存配置"生效。
                    </p>
                  </div>
                </div>
              )}

              {/* Debug */}
              {activeSection === "debug" && (
                <div className="grid gap-4">
                  <p className="text-[13px] text-muted">开发调试工具</p>

                  <div className="rounded-xl border border-ink-900/10 bg-white/70 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <path d="M8 21h8M12 17v4" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-ink-800">开屏页预览</p>
                        <p className="text-[11px] text-muted-light">重新展示冷启动开屏引导页</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        setTimeout(() => onShowSplash?.(), 300);
                      }}
                      className="w-full rounded-xl px-4 py-2.5 text-[13px] font-medium text-white shadow-soft transition-colors"
                      style={{ background: '#2C5F2F' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#3A7A3D'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#2C5F2F'; }}
                    >
                      显示开屏页
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      localStorage.removeItem("vk-cowork-splash-seen");
                    }}
                    className="text-left text-xs text-muted hover:text-ink-700 transition-colors"
                  >
                    重置开屏页状态（下次启动时重新显示）
                  </button>
                </div>
              )}

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
            </main>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-ink-900/8 flex-shrink-0" style={{ background: '#F6F4F0' }}>
            {showSaveButton && (
              <button
                type="button"
                onClick={handleSave}
                disabled={validating || saving}
                className="rounded-xl px-5 py-2 text-[13px] font-medium text-white shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: '#2C5F2F' }}
                onMouseEnter={(e) => { if (!validating && !saving) (e.currentTarget as HTMLButtonElement).style.background = '#3A7A3D'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#2C5F2F'; }}
              >
                {validating ? (
                  <span className="flex items-center gap-2">
                    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    验证中...
                  </span>
                ) : saving ? (
                  <span className="flex items-center gap-2">
                    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    保存中...
                  </span>
                ) : saved ? (
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12l4 4L19 6" />
                    </svg>
                    已保存
                  </span>
                ) : (
                  "保存配置"
                )}
              </button>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-xl px-5 py-2 text-[13px] font-medium text-white transition-colors"
                style={{ background: '#2C5F2F' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#3A7A3D'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#2C5F2F'; }}
              >
                完成
              </button>
            </Dialog.Close>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
