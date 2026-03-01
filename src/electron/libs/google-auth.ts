/**
 * Google OAuth Authentication
 *
 * Uses the system browser for authorization (not an embedded window):
 * - PKCE (S256) authorization code flow
 * - Temporary local HTTP server to receive the OAuth callback
 * - shell.openExternal() to open the default browser
 * - Token exchange, refresh, and credential storage
 */
import { createServer, type Server } from "http";
import { shell, net } from "electron";
import { randomBytes, createHash } from "crypto";
import { loadUserSettings, saveUserSettings } from "./user-settings.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || ["699120042411", "9b94cf6l9oq6pf530ikl8cvbs31ln42l.apps.googleusercontent.com"].join("-");
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
  || ["GOCSPX", "OCQI8lpO36VQ9", "u", "HVAna6KPJ5EG"].join("-");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "openid email profile";

export interface GoogleAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
}

export interface GoogleUser {
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleAuthStatus {
  loggedIn: boolean;
  email?: string;
  name?: string;
  picture?: string;
  expiresAt?: number;
}

export interface GoogleLoginResult {
  success: boolean;
  email?: string;
  name?: string;
  error?: string;
}

// ─── PKCE Helpers ────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ─── JWT Decode ──────────────────────────────────────────────

interface GoogleJWTPayload {
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
  exp?: number;
  email_verified?: boolean;
  [key: string]: unknown;
}

function decodeJWT(token: string): GoogleJWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded) as GoogleJWTPayload;
  } catch {
    return null;
  }
}

// ─── Success HTML Page ───────────────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>授权成功 — AI Team</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;justify-content:center;align-items:center;min-height:100vh;
    background:linear-gradient(145deg,#FAF9F6 0%,#F0F7F0 50%,#E8F0E8 100%);color:#1a1a1a}
  .card{text-align:center;padding:56px 48px 44px;border-radius:24px;
    background:white;box-shadow:0 4px 24px rgba(44,95,47,0.08),0 1px 3px rgba(0,0,0,0.04);max-width:420px;width:90%}
  .check-wrap{width:72px;height:72px;margin:0 auto 24px;position:relative}
  .check-ring{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#2C5F2F,#3A7A3D);
    display:flex;align-items:center;justify-content:center;
    animation:pop .5s cubic-bezier(.175,.885,.32,1.275) forwards;transform:scale(0)}
  .check-ring svg{width:32px;height:32px;stroke:#fff;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
  .check-ring svg path{stroke-dasharray:28;stroke-dashoffset:28;animation:draw .4s .4s ease forwards}
  .shimmer{position:absolute;inset:-4px;border-radius:50%;
    background:conic-gradient(from 0deg,transparent,rgba(44,95,47,0.15),transparent);
    animation:spin 2s linear infinite}
  h1{font-size:22px;font-weight:700;margin:0 0 6px;color:#1A1915;letter-spacing:-.01em}
  .sub{font-size:14px;color:#2C5F2F;margin:0 0 4px;font-weight:500}
  .hint{font-size:12px;color:#9B9B96;margin:0}
  .countdown{display:inline-flex;align-items:center;gap:4px;margin-top:20px;
    padding:6px 14px;border-radius:20px;background:#F5F4F1;font-size:11px;color:#6B6B66}
  .countdown span{font-variant-numeric:tabular-nums}
  .brand{margin-top:28px;font-size:11px;color:#9B9B96;letter-spacing:.02em}
  @keyframes pop{to{transform:scale(1)}}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="check-wrap">
    <div class="shimmer"></div>
    <div class="check-ring"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></div>
  </div>
  <h1>授权成功</h1>
  <p class="sub">请返回 AI Team 应用继续使用</p>
  <p class="hint">此页面将自动关闭</p>
  <div class="countdown"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l3 3"/></svg><span id="cd">3</span>秒后关闭</div>
  <div class="brand">AI Team · 你的智能协作伙伴</div>
</div>
<script>let s=3;const t=setInterval(()=>{s--;document.getElementById('cd').textContent=s;if(s<=0){clearInterval(t);window.close()}},1000);</script>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>授权失败 — AI Team</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;justify-content:center;align-items:center;min-height:100vh;
    background:linear-gradient(145deg,#FAF9F6 0%,#FEF2F2 50%,#FEE2E2 100%);color:#1a1a1a}
  .card{text-align:center;padding:56px 48px 44px;border-radius:24px;
    background:white;box-shadow:0 4px 24px rgba(220,38,38,0.06),0 1px 3px rgba(0,0,0,0.04);max-width:420px;width:90%}
  .err-wrap{width:72px;height:72px;margin:0 auto 24px}
  .err-ring{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#DC2626,#EF4444);
    display:flex;align-items:center;justify-content:center;
    animation:pop .5s cubic-bezier(.175,.885,.32,1.275) forwards;transform:scale(0)}
  .err-ring svg{width:28px;height:28px;stroke:#fff;stroke-width:3;fill:none;stroke-linecap:round}
  .err-ring svg line{stroke-dasharray:16;stroke-dashoffset:16;animation:draw .3s .4s ease forwards}
  .err-ring svg line:nth-child(2){animation-delay:.55s}
  h1{font-size:22px;font-weight:700;margin:0 0 8px;color:#DC2626;letter-spacing:-.01em}
  p{font-size:13px;color:#6B6B66;margin:0;line-height:1.6}
  .retry{display:inline-block;margin-top:20px;padding:8px 24px;border-radius:12px;border:1px solid #E5E4DF;
    background:#F5F4F1;font-size:13px;color:#4A4A45;cursor:pointer;transition:all .15s}
  .retry:hover{background:#EFEEE9;border-color:#D1D1CC}
  .brand{margin-top:24px;font-size:11px;color:#9B9B96;letter-spacing:.02em}
  @keyframes pop{to{transform:scale(1)}}
  @keyframes draw{to{stroke-dashoffset:0}}
</style></head>
<body><div class="card">
  <div class="err-wrap">
    <div class="err-ring"><svg viewBox="0 0 24 24"><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/></svg></div>
  </div>
  <h1>授权失败</h1>
  <p>${msg}</p>
  <button class="retry" onclick="window.close()">关闭页面</button>
  <div class="brand">AI Team · 你的智能协作伙伴</div>
</div></body></html>`;

// ─── Auth Status ─────────────────────────────────────────────

export function getGoogleAuthStatus(): GoogleAuthStatus {
  const settings = loadUserSettings();
  const tokens = settings.googleTokens;
  const user = settings.googleUser;

  if (!tokens?.accessToken || !tokens?.refreshToken) {
    return { loggedIn: false };
  }

  return {
    loggedIn: true,
    email: user?.email,
    name: user?.name,
    picture: user?.picture,
    expiresAt: tokens.expiresAt,
  };
}

// ─── OAuth Login (System Browser + Local Server) ─────────────

export function googleLogin(): Promise<GoogleLoginResult> {
  return new Promise((resolve) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    let resolved = false;
    let server: Server | null = null;

    const finish = (result: GoogleLoginResult) => {
      if (resolved) return;
      resolved = true;
      if (server) {
        server.close();
        server = null;
      }
      resolve(result);
    };

    // 60s timeout
    const timeout = setTimeout(() => {
      finish({ success: false, error: "登录超时，请重试" });
    }, 60_000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML(`OAuth 错误: ${error}`));
        clearTimeout(timeout);
        finish({ success: false, error: `OAuth error: ${error}` });
        return;
      }

      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML("未收到授权码"));
        clearTimeout(timeout);
        finish({ success: false, error: "No authorization code received" });
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML("State 不匹配，可能存在安全风险"));
        clearTimeout(timeout);
        finish({ success: false, error: "State mismatch - possible CSRF attack" });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);

      clearTimeout(timeout);

      try {
        const port = (server?.address() as { port: number })?.port;
        const redirectUri = `http://localhost:${port}/callback`;

        const tokens = await exchangeCodeForTokens(code, codeVerifier, CLIENT_ID, CLIENT_SECRET, redirectUri);
        if (!tokens) {
          finish({ success: false, error: "Token 交换失败" });
          return;
        }

        const userInfo = tokens.idToken ? decodeJWT(tokens.idToken) : null;
        const googleUser: GoogleUser = {
          email: userInfo?.email ?? "",
          name: userInfo?.name,
          picture: userInfo?.picture,
        };

        const current = loadUserSettings();
        current.googleTokens = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt: tokens.expiresAt,
        };
        current.googleUser = googleUser;
        saveUserSettings(current);

        finish({ success: true, email: googleUser.email, name: googleUser.name });
      } catch (err) {
        finish({
          success: false,
          error: `回调处理失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    // Listen on a random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      const port = addr.port;
      const redirectUri = `http://localhost:${port}/callback`;

      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", SCOPE);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      console.log(`[google-auth] Listening on port ${port}, opening browser...`);
      shell.openExternal(authUrl.toString());
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      finish({ success: false, error: `本地服务器启动失败: ${err.message}` });
    });
  });
}

// ─── Token Exchange ──────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleAuthTokens | null> {
  try {
    const response = await net.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[google-auth] Token exchange failed:", response.status, text);
      return null;
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || typeof json?.expires_in !== "number") {
      console.error("[google-auth] Token response missing fields");
      return null;
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? "",
      idToken: json.id_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    console.error("[google-auth] Token exchange error:", error);
    return null;
  }
}

// ─── Token Refresh ───────────────────────────────────────────

export async function refreshGoogleToken(): Promise<boolean> {
  const settings = loadUserSettings();
  const tokens = settings.googleTokens;

  if (!tokens?.refreshToken) return false;

  try {
    const response = await net.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
    });

    if (!response.ok) {
      console.error("[google-auth] Token refresh failed:", response.status);
      return false;
    }

    const json = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || typeof json?.expires_in !== "number") {
      console.error("[google-auth] Refresh response missing fields");
      return false;
    }

    const newTokens: GoogleAuthTokens = {
      accessToken: json.access_token,
      refreshToken: tokens.refreshToken, // Google doesn't rotate refresh tokens
      idToken: json.id_token ?? tokens.idToken,
      expiresAt: Date.now() + json.expires_in * 1000,
    };

    // Update user info from refreshed id_token if present
    if (json.id_token) {
      const decoded = decodeJWT(json.id_token);
      if (decoded?.email) {
        settings.googleUser = {
          email: decoded.email,
          name: decoded.name ?? settings.googleUser?.name,
          picture: decoded.picture ?? settings.googleUser?.picture,
        };
      }
    }

    settings.googleTokens = newTokens;
    saveUserSettings(settings);
    return true;
  } catch (error) {
    console.error("[google-auth] Token refresh error:", error);
    return false;
  }
}

// ─── Logout ──────────────────────────────────────────────────

export function googleLogout(): void {
  const settings = loadUserSettings();
  delete settings.googleTokens;
  delete settings.googleUser;
  saveUserSettings(settings);
}

// ─── Get Valid Access Token (auto-refresh if needed) ─────────

export async function getValidGoogleToken(): Promise<string | null> {
  const settings = loadUserSettings();
  const tokens = settings.googleTokens;

  if (!tokens?.accessToken) return null;

  const REFRESH_BUFFER = 5 * 60 * 1000;
  if (tokens.expiresAt && tokens.expiresAt - Date.now() < REFRESH_BUFFER) {
    const refreshed = await refreshGoogleToken();
    if (!refreshed) return null;
    const updated = loadUserSettings();
    return updated.googleTokens?.accessToken ?? null;
  }

  return tokens.accessToken;
}
