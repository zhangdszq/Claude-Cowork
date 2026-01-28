import { query, type SDKMessage, type PermissionResult, unstable_v2_prompt, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Session } from './session.js';
import { recordMessage, updateSession, addPendingPermission } from './session.js';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

// Server event types
export type ServerEvent =
  | { type: 'session.status'; payload: { sessionId: string; status: string; title?: string; cwd?: string; error?: string } }
  | { type: 'stream.message'; payload: { sessionId: string; message: SDKMessage } }
  | { type: 'stream.user_prompt'; payload: { sessionId: string; prompt: string } }
  | { type: 'permission.request'; payload: { sessionId: string; toolUseId: string; toolName: string; input: unknown } }
  | { type: 'runner.error'; payload: { sessionId?: string; message: string } }
  | { type: 'session.list'; payload: { sessions: unknown[] } }
  | { type: 'session.history'; payload: { sessionId: string; status: string; messages: unknown[]; pendingPermissions: unknown[] } }
  | { type: 'session.deleted'; payload: { sessionId: string } };

// Runner options
export type RunnerOptions = {
  prompt: string;
  session: Session;
  resumeSessionId?: string;
  onSessionUpdate?: (updates: Partial<Session>) => void;
};

// Track active abort controllers
const activeControllers = new Map<string, AbortController>();

// Get Claude Code CLI path
function getClaudeCodePath(): string | undefined {
  // Check for bundled CLI first
  const bundledPath = process.env.CLAUDE_CLI_PATH;
  if (bundledPath && existsSync(bundledPath)) {
    return bundledPath;
  }

  // Check for system-installed Claude Code
  const systemPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(homedir(), '.npm-global/bin/claude'),
  ];

  for (const p of systemPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return undefined;
}

// Build enhanced environment
function getEnhancedEnv(): Record<string, string | undefined> {
  const home = homedir();
  const additionalPaths = [
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
  const newPath = [...additionalPaths, currentPath].join(':');

  // Load Claude-specific env vars
  const claudeEnv: Record<string, string | undefined> = {};
  
  // Check for custom API settings from environment
  if (process.env.ANTHROPIC_API_KEY) {
    claudeEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    claudeEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }
  if (process.env.ANTHROPIC_MODEL) {
    claudeEnv.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
  }

  // Proxy settings - apply to HTTP_PROXY, HTTPS_PROXY, ALL_PROXY
  if (process.env.PROXY_URL) {
    claudeEnv.HTTP_PROXY = process.env.PROXY_URL;
    claudeEnv.HTTPS_PROXY = process.env.PROXY_URL;
    claudeEnv.ALL_PROXY = process.env.PROXY_URL;
    claudeEnv.http_proxy = process.env.PROXY_URL;
    claudeEnv.https_proxy = process.env.PROXY_URL;
    claudeEnv.all_proxy = process.env.PROXY_URL;
  }

  return {
    ...process.env,
    ...claudeEnv,
    PATH: newPath,
  };
}

const claudeCodePath = getClaudeCodePath();
const enhancedEnv = getEnhancedEnv();

// Stop a session by ID (supports both internal and external IDs)
export function stopSession(sessionId: string): boolean {
  console.log('[Runner] Stopping session:', sessionId);
  console.log('[Runner] Active controllers:', Array.from(activeControllers.keys()));
  
  const controller = activeControllers.get(sessionId);
  if (controller) {
    console.log('[Runner] Found controller, aborting...');
    controller.abort();
    // Don't delete here - let runClaude's finally block handle cleanup
    // This ensures proper cleanup order
    return true;
  }
  
  console.log('[Runner] No controller found for:', sessionId);
  return false;
}

// Run Claude query
export async function* runClaude(options: RunnerOptions): AsyncGenerator<ServerEvent> {
  const { prompt, session, resumeSessionId, onSessionUpdate } = options;
  const abortController = new AbortController();
  
  // Track this controller - use externalId if available for cross-process stop
  const trackingId = session.externalId || session.id;
  activeControllers.set(trackingId, abortController);
  console.log('[Runner] Tracking session with ID:', trackingId);

  const DEFAULT_CWD = process.cwd();

  // Queue for permission requests that need to be yielded
  const permissionRequestQueue: ServerEvent[] = [];

  console.log('[Runner] Starting Claude query:', { prompt: prompt.slice(0, 50), cwd: session.cwd ?? DEFAULT_CWD, resume: resumeSessionId });
  console.log('[Runner] Claude Code path:', claudeCodePath);

  try {
    const q = query({
      prompt,
      options: {
        cwd: session.cwd ?? DEFAULT_CWD,
        resume: resumeSessionId,
        abortController,
        env: enhancedEnv,
        pathToClaudeCodeExecutable: claudeCodePath,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        allowDangerouslySkipPermissions: true,
        // Load user settings to enable skills from ~/.claude/skills/
        settingSources: ['user', 'project', 'local'],
        canUseTool: async (toolName, input, { signal, toolUseID }) => {
          // For AskUserQuestion, we need to wait for user response
          if (toolName === 'AskUserQuestion') {
            // Use the SDK's toolUseID for proper matching
            const toolUseId = toolUseID;

            console.log('[Runner] AskUserQuestion requested, toolUseId:', toolUseId);

            // Queue permission request to be yielded
            permissionRequestQueue.push({
              type: 'permission.request',
              payload: { sessionId: session.id, toolUseId, toolName, input },
            });

            // Create a promise that will be resolved when user responds
            return new Promise<PermissionResult>((resolve) => {
              addPendingPermission(session.id, {
                toolUseId,
                toolName,
                input,
                resolve: (result) => {
                  console.log('[Runner] Permission resolved:', toolUseId, result.behavior);
                  resolve(result as PermissionResult);
                },
              });

              // Handle abort
              signal.addEventListener('abort', () => {
                resolve({ behavior: 'deny', message: 'Session aborted' });
              });
            });
          }

          // Auto-approve other tools
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });

    console.log('[Runner] Query created, waiting for messages...');

    // Process messages
    for await (const message of q) {
      // Check if aborted before processing each message
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected, stopping message processing');
        break;
      }

      console.log('[Runner] Received message:', message.type, 'subtype' in message ? (message as any).subtype : '');
      
      // Yield any queued permission requests first
      while (permissionRequestQueue.length > 0) {
        const permReq = permissionRequestQueue.shift();
        if (permReq) yield permReq;
      }

      // Check abort again after yielding permission requests
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected after permission queue, stopping');
        break;
      }

      // Extract session_id from system init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        const sdkSessionId = (message as any).session_id;
        if (sdkSessionId) {
          session.claudeSessionId = sdkSessionId;
          onSessionUpdate?.({ claudeSessionId: sdkSessionId });
        }
      }

      // Check abort before yielding message
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected before yielding message, stopping');
        break;
      }

      // Record message
      recordMessage(session.id, message);

      // Yield message event
      yield {
        type: 'stream.message',
        payload: { sessionId: session.id, message },
      };

      // Check abort after yielding
      if (abortController.signal.aborted) {
        console.log('[Runner] Abort detected after yielding message, stopping');
        break;
      }

      // Check for result to update session status
      if (message.type === 'result') {
        const status = (message as any).subtype === 'success' ? 'completed' : 'error';
        updateSession(session.id, { status });
        yield {
          type: 'session.status',
          payload: { sessionId: session.id, status, title: session.title },
        };
      }
    }

    // Check if aborted before marking as completed
    if (abortController.signal.aborted) {
      console.log('[Runner] Session aborted during processing');
      updateSession(session.id, { status: 'idle' });
      yield {
        type: 'session.status',
        payload: { sessionId: session.id, status: 'idle', title: session.title },
      };
      return;
    }

    // Query completed normally
    if (session.status === 'running') {
      updateSession(session.id, { status: 'completed' });
      yield {
        type: 'session.status',
        payload: { sessionId: session.id, status: 'completed', title: session.title },
      };
    }
  } catch (error) {
    console.error('[Runner] Error:', error);
    
    if ((error as Error).name === 'AbortError' || abortController.signal.aborted) {
      // Session was aborted, send idle status
      console.log('[Runner] Session aborted');
      updateSession(session.id, { status: 'idle' });
      yield {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: 'idle',
          title: session.title,
        },
      };
      return;
    }
    
    updateSession(session.id, { status: 'error' });
    yield {
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'error',
        title: session.title,
        error: String(error),
      },
    };
  } finally {
    console.log('[Runner] Finished, cleaning up:', trackingId);
  
    // If aborted, ensure status is set to idle
    if (abortController.signal.aborted) {
      updateSession(session.id, { status: 'idle' });
    }
  
    // Clean up controller
    activeControllers.delete(trackingId);
  }
}

// Generate session title using Claude
export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';

  try {
    const result: SDKResultMessage = await unstable_v2_prompt(
      `please analyze the following user input to generate a short but clear title to identify this conversation theme:
      ${userIntent}
      directly output the title, do not include any other content`,
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        env: enhancedEnv,
        pathToClaudeCodeExecutable: claudeCodePath,
      }
    );

    if (result.subtype === 'success') {
      return result.result;
    }
  } catch (error) {
    console.error('Failed to generate session title:', error);
  }

  return 'New Session';
}
