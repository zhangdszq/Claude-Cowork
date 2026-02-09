/**
 * IPC handlers for communication between renderer and main process.
 * Uses API sidecar when available, falls back to direct SDK when not.
 */
import { BrowserWindow } from 'electron';
import type { ClientEvent, ServerEvent } from './types.js';
import { SessionStore } from './libs/session-store.js';
import { runClaude, type RunnerHandle } from './libs/runner.js';
import { runCodex } from './libs/codex-runner.js';
import { isEmbeddedApiRunning } from './api/server.js';
import {
  startSession as apiStartSession,
  continueSession as apiContinueSession,
  stopSession as apiStopSession,
  sendPermissionResponse as apiSendPermissionResponse,
} from './libs/api-client.js';
import { app } from 'electron';
import { join } from 'path';

// Local session store for persistence (SQLite)
const DB_PATH = join(app.getPath('userData'), 'sessions.db');
const sessions = new SessionStore(DB_PATH);

// Track runner handles for direct mode
const runnerHandles = new Map<string, RunnerHandle>();

// Track active sessions
const activeSessions = new Set<string>();

function broadcast(event: ServerEvent) {
  const payload = JSON.stringify(event);
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('server-event', payload);
  }
}

function emit(event: ServerEvent) {
  // Persist relevant events to local store
  if (event.type === 'session.status' && 'payload' in event) {
    const { sessionId, status } = event.payload as { sessionId: string; status: string };
    sessions.updateSession(sessionId, { status: status as any });
  }
  if (event.type === 'stream.message' && 'payload' in event) {
    const { sessionId, message } = event.payload as { sessionId: string; message: any };
    sessions.recordMessage(sessionId, message);
    
    // Capture claudeSessionId from init message
    if (message?.type === 'system' && message?.subtype === 'init' && message?.session_id) {
      console.log('[IPC] Captured claudeSessionId:', message.session_id);
      sessions.updateSession(sessionId, { claudeSessionId: message.session_id });
    }
  }
  if (event.type === 'stream.user_prompt' && 'payload' in event) {
    const { sessionId, prompt } = event.payload as { sessionId: string; prompt: string };
    sessions.recordMessage(sessionId, {
      type: 'user_prompt',
      prompt,
    });
  }
  
  broadcast(event);
}

// Check if we should use embedded API or direct SDK
function useEmbeddedApi(): boolean {
  return isEmbeddedApiRunning();
}

export async function handleClientEvent(event: ClientEvent) {
  if (event.type === 'session.list') {
    emit({
      type: 'session.list',
      payload: { sessions: sessions.listSessions() },
    });
    return;
  }

  if (event.type === 'session.history') {
    const history = sessions.getSessionHistory(event.payload.sessionId);
    if (!history) {
      emit({
        type: 'runner.error',
        payload: { message: 'Unknown session' },
      });
      return;
    }

    // Get pending permissions from the session
    const session = sessions.getSession(event.payload.sessionId);
    const pendingPermissions = session ? 
      Array.from(session.pendingPermissions.values()).map(p => ({
        toolUseId: p.toolUseId,
        toolName: p.toolName,
        input: p.input
      })) : [];

    emit({
      type: 'session.history',
      payload: {
        sessionId: history.session.id,
        status: history.session.status,
        messages: history.messages,
        pendingPermissions,
      },
    });
    return;
  }

  if (event.type === 'session.start') {
    const provider = event.payload.provider ?? 'claude';
    const session = sessions.createSession({
      cwd: event.payload.cwd,
      title: event.payload.title,
      allowedTools: event.payload.allowedTools,
      prompt: event.payload.prompt,
      provider,
      model: event.payload.model,
    });

    sessions.updateSession(session.id, {
      status: 'running',
      lastPrompt: event.payload.prompt,
    });

    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'running',
        title: session.title,
        cwd: session.cwd,
        provider,
      },
    });

    if (useEmbeddedApi()) {
      // Use sidecar API for both Claude and Codex — supports multi-instance
      activeSessions.add(session.id);
      try {
        await apiStartSession(
          {
            cwd: event.payload.cwd,
            title: event.payload.title,
            allowedTools: event.payload.allowedTools,
            prompt: event.payload.prompt,
            externalSessionId: session.id,
            provider,
            model: event.payload.model,
          },
          (apiEvent) => {
            // Map API session ID to local session ID
            if ('payload' in apiEvent && 'sessionId' in (apiEvent.payload as any)) {
              (apiEvent.payload as any).sessionId = session.id;
            }
            
            // Capture claudeSessionId/threadId from init message
            if (apiEvent.type === 'stream.message') {
              const msg = (apiEvent.payload as any).message;
              if (msg?.type === 'system' && msg?.subtype === 'init' && msg?.session_id) {
                sessions.updateSession(session.id, { claudeSessionId: msg.session_id });
              }
            }
            
            emit(apiEvent);
          }
        );
      } catch (error) {
        sessions.updateSession(session.id, { status: 'error' });
        emit({
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: 'error',
            title: session.title,
            cwd: session.cwd,
            error: String(error),
          },
        });
      } finally {
        activeSessions.delete(session.id);
      }
    } else {
      // Fallback: direct SDK when sidecar is unavailable
      emit({
        type: 'stream.user_prompt',
        payload: { sessionId: session.id, prompt: event.payload.prompt },
      });

      if (provider === 'codex') {
        runCodex({
          prompt: event.payload.prompt,
          session,
          model: event.payload.model,
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
      } else {
        runClaude({
          prompt: event.payload.prompt,
          session,
          resumeSessionId: session.claudeSessionId,
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
            sessions.setAbortController(session.id, undefined);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
      }
    }

    return;
  }

  if (event.type === 'session.continue') {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) {
      emit({
        type: 'runner.error',
        payload: { message: 'Unknown session' },
      });
      return;
    }

    if (!session.claudeSessionId) {
      emit({
        type: 'runner.error',
        payload: { sessionId: session.id, message: 'Session has no resume id yet.' },
      });
      return;
    }

    sessions.updateSession(session.id, {
      status: 'running',
      lastPrompt: event.payload.prompt,
    });

    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'running',
        title: session.title,
        cwd: session.cwd,
      },
    });

    const sessionProvider = session.provider ?? 'claude';

    if (useEmbeddedApi()) {
      // Use sidecar API for both Claude and Codex — supports multi-instance
      activeSessions.add(session.id);
      try {
        await apiContinueSession(
          session.claudeSessionId!,
          event.payload.prompt,
          (apiEvent) => {
            if ('payload' in apiEvent && 'sessionId' in (apiEvent.payload as any)) {
              (apiEvent.payload as any).sessionId = session.id;
            }
            emit(apiEvent);
          },
          {
            cwd: session.cwd,
            title: session.title,
            externalSessionId: session.id,
            provider: sessionProvider,
            model: session.model,
          }
        );
      } catch (error) {
        sessions.updateSession(session.id, { status: 'error' });
        emit({
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: 'error',
            title: session.title,
            cwd: session.cwd,
            error: String(error),
          },
        });
      } finally {
        activeSessions.delete(session.id);
      }
    } else {
      // Fallback: direct SDK when sidecar is unavailable
      emit({
        type: 'stream.user_prompt',
        payload: { sessionId: session.id, prompt: event.payload.prompt },
      });

      if (sessionProvider === 'codex') {
        runCodex({
          prompt: event.payload.prompt,
          session,
          model: session.model,
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
      } else {
        runClaude({
          prompt: event.payload.prompt,
          session,
          resumeSessionId: session.claudeSessionId,
          onEvent: emit,
          onSessionUpdate: (updates) => {
            sessions.updateSession(session.id, updates);
          },
        })
          .then((handle) => {
            runnerHandles.set(session.id, handle);
          })
          .catch((error) => {
            sessions.updateSession(session.id, { status: 'error' });
            emit({
              type: 'session.status',
              payload: { sessionId: session.id, status: 'error', title: session.title, cwd: session.cwd, error: String(error) },
            });
          });
      }
    }

    return;
  }

  if (event.type === 'session.stop') {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) return;

    if (useEmbeddedApi()) {
      try {
        await apiStopSession(session.id);
      } catch (error) {
        console.error('Failed to stop session via API:', error);
      }
      activeSessions.delete(session.id);
    } else {
      const handle = runnerHandles.get(session.id);
      if (handle) {
        handle.abort();
        runnerHandles.delete(session.id);
      }
    }

    sessions.updateSession(session.id, { status: 'idle' });
    emit({
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'idle',
        title: session.title,
        cwd: session.cwd,
      },
    });
    return;
  }

  if (event.type === 'session.delete') {
    const sessionId = event.payload.sessionId;

    if (useEmbeddedApi()) {
      if (activeSessions.has(sessionId)) {
        try {
          await apiStopSession(sessionId);
        } catch (error) {
          console.error('Failed to stop session via API:', error);
        }
        activeSessions.delete(sessionId);
      }
    } else {
      const handle = runnerHandles.get(sessionId);
      if (handle) {
        handle.abort();
        runnerHandles.delete(sessionId);
      }
    }

    sessions.deleteSession(sessionId);
    emit({
      type: 'session.deleted',
      payload: { sessionId },
    });
    return;
  }

  if (event.type === 'permission.response') {
    if (useEmbeddedApi()) {
      try {
        await apiSendPermissionResponse(
          event.payload.sessionId,
          event.payload.toolUseId,
          event.payload.result
        );
      } catch (error) {
        console.error('Failed to send permission response:', error);
      }
    } else {
      // Direct mode - resolve the pending permission
      const session = sessions.getSession(event.payload.sessionId);
      if (session) {
        const pending = session.pendingPermissions.get(event.payload.toolUseId);
        if (pending) {
          pending.resolve(event.payload.result);
        }
      }
    }
    return;
  }
}

export { sessions };
