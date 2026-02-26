import { useCallback, useState } from "react";

type WizardStep = "welcome" | "api" | "codex" | "complete";

interface OnboardingWizardProps {
  onComplete: () => void;
}

// Step indicator
function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
  const steps = [
    { id: "welcome", label: "欢迎" },
    { id: "api", label: "Claude" },
    { id: "codex", label: "Codex" },
    { id: "complete", label: "完成" },
  ];
  
  const currentIndex = steps.findIndex(s => s.id === currentStep);
  
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((step, index) => {
        const isActive = index === currentIndex;
        const isCompleted = index < currentIndex;
        
        return (
          <div key={step.id} className="flex items-center">
            <div className={`
              flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium transition-all
              ${isActive ? "bg-accent text-white scale-110" : 
                isCompleted ? "bg-success text-white" : 
                "bg-ink-900/10 text-muted"}
            `}>
              {isCompleted ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                index + 1
              )}
            </div>
            {index < steps.length - 1 && (
              <div className={`w-12 h-0.5 mx-1 ${isCompleted ? "bg-success" : "bg-ink-900/10"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  
  // API config state
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Codex auth state
  const [codexLoggedIn, setCodexLoggedIn] = useState(false);
  const [codexEmail, setCodexEmail] = useState<string | undefined>();
  const [codexLoggingIn, setCodexLoggingIn] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  // Save API config
  const handleSaveApi = useCallback(async () => {
    setValidationError(null);
    
    if (!authToken.trim()) {
      setValidationError("请输入 API Token");
      return;
    }

    setValidating(true);
    try {
      const result = await window.electron.validateApiConfig(
        baseUrl.trim() || undefined,
        authToken.trim()
      );

      if (!result.valid) {
        setValidationError(result.message);
        setValidating(false);
        return;
      }

      // Save settings
      await window.electron.saveUserSettings({
        anthropicBaseUrl: baseUrl.trim() || undefined,
        anthropicAuthToken: authToken.trim(),
      });

      setValidating(false);
      setStep("codex");
    } catch (error) {
      setValidationError("验证失败: " + (error instanceof Error ? error.message : String(error)));
      setValidating(false);
    }
  }, [baseUrl, authToken]);

  // Skip API config
  const handleSkipApi = useCallback(() => {
    setStep("codex");
  }, []);

  // Codex login
  const handleCodexLogin = useCallback(async () => {
    setCodexLoggingIn(true);
    setCodexError(null);
    try {
      const result = await window.electron.openaiLogin();
      if (result.success) {
        setCodexLoggedIn(true);
        setCodexEmail(result.email);
      } else {
        setCodexError(result.error || "登录失败");
      }
    } catch (err) {
      setCodexError("登录过程出错: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCodexLoggingIn(false);
    }
  }, []);

  // Skip Codex config
  const handleSkipCodex = useCallback(() => {
    setStep("complete");
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-surface via-surface-secondary to-surface-tertiary">
      <div className="w-full max-w-xl mx-4">
        <StepIndicator currentStep={step} />
        
        <div className="rounded-3xl border border-ink-900/10 bg-surface shadow-elevated overflow-hidden">
          {/* Welcome Step */}
          {step === "welcome" && (
            <div className="p-8 text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-accent to-accent-hover flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-10 w-10 text-white" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-ink-900 mb-3">欢迎使用 AI Team</h1>
              <p className="text-muted mb-8 leading-relaxed">
                AI Team 是一个强大的 AI 编程助手客户端。<br />
                只需配置 API Token 即可开始使用。
              </p>
              <button
                onClick={() => setStep("api")}
                className="w-full rounded-xl bg-accent px-6 py-3.5 text-base font-medium text-white shadow-soft hover:bg-accent-hover transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                开始配置
              </button>
              <p className="mt-4 text-xs text-muted-light">
                所有功能已内置，无需安装任何依赖
              </p>
            </div>
          )}

          {/* API Config Step */}
          {step === "api" && (
            <div className="p-8">
              <h2 className="text-xl font-semibold text-ink-900 text-center mb-2">配置 API</h2>
              <p className="text-sm text-muted text-center mb-6">
                输入您的 Anthropic API Token 以开始使用
              </p>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-xs font-medium text-muted mb-1.5 block">API Base URL（可选）</span>
                  <input
                    type="url"
                    className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-3 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    placeholder="https://api.anthropic.com"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-light mt-1 block">
                    自定义 API 端点，留空使用官方 API
                  </span>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-muted mb-1.5 block">API Token *</span>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      className="w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-3 pr-12 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors font-mono"
                      placeholder="sk-ant-api03-..."
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted hover:text-ink-700 transition-colors"
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
                  <span className="text-[11px] text-muted-light mt-1 block">
                    从 <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">console.anthropic.com</a> 获取您的 API Key
                  </span>
                </label>

                {validationError && (
                  <div className="rounded-xl border border-error/20 bg-error/5 p-3">
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
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={handleSkipApi}
                  className="flex-1 rounded-xl border border-ink-900/10 bg-surface px-4 py-3 text-sm text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                >
                  稍后配置
                </button>
                <button
                  onClick={handleSaveApi}
                  disabled={validating || !authToken.trim()}
                  className="flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:opacity-50"
                >
                  {validating ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      验证中...
                    </span>
                  ) : (
                    "保存并继续"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Codex Auth Step */}
          {step === "codex" && (
            <div className="p-8">
              <div className="flex justify-center mb-4">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="h-7 w-7 text-emerald-600" fill="currentColor">
                    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                  </svg>
                </div>
              </div>
              <h2 className="text-xl font-semibold text-ink-900 text-center mb-2">授权 OpenAI Codex</h2>
              <p className="text-sm text-muted text-center mb-6">
                使用 ChatGPT 账号登录，即可使用 Codex 模型（gpt-5.3-codex）
              </p>

              {codexLoggedIn ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-success/20 bg-success/5 p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12l4 4L19 6" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink-800">已登录 OpenAI</p>
                        {codexEmail && (
                          <p className="text-xs text-muted truncate">{codexEmail}</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setStep("complete")}
                    className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors"
                  >
                    继续
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-ink-900/10 bg-surface-secondary p-4">
                    <p className="text-xs text-muted leading-relaxed">
                      通过 ChatGPT 账号 OAuth 授权登录，使用 Plus/Pro 订阅额度访问 Codex 模型，无需额外 API 费用。
                    </p>
                  </div>

                  {codexError && (
                    <div className="rounded-xl border border-error/20 bg-error/5 p-3">
                      <p className="text-xs text-error flex items-start gap-2">
                        <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                        <span>{codexError}</span>
                      </p>
                    </div>
                  )}

                  <button
                    onClick={handleCodexLogin}
                    disabled={codexLoggingIn}
                    className="w-full rounded-xl bg-[#10a37f] px-4 py-3 text-sm font-medium text-white shadow-soft hover:bg-[#0d8c6d] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {codexLoggingIn ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
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

                  <button
                    onClick={handleSkipCodex}
                    disabled={codexLoggingIn}
                    className="w-full rounded-xl border border-ink-900/10 bg-surface px-4 py-3 text-sm text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors disabled:opacity-50"
                  >
                    稍后配置
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Complete Step */}
          {step === "complete" && (
            <div className="p-8 text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-success/10 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-10 w-10 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-ink-900 mb-3">准备就绪！</h2>
              <p className="text-muted mb-8 leading-relaxed">
                配置已保存，现在可以开始使用了。<br />
                您可以随时在设置中修改配置。
              </p>
              <button
                onClick={onComplete}
                className="w-full rounded-xl bg-accent px-6 py-3.5 text-base font-medium text-white shadow-soft hover:bg-accent-hover transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                开始使用
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 text-center text-xs text-muted-light">
          AI Team
        </div>
      </div>
    </div>
  );
}
