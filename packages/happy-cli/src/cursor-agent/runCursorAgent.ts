/**
 * Cursor Agent Entry Point
 *
 * Integrates cursor-agent with Happy using --print --output-format stream-json mode.
 * cursor-agent outputs Claude-compatible stream-json, so we reuse Claude's message parsing.
 * Sessions are maintained across turns via cursor-agent's --resume <chatId> flag.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import type { ApiSessionClient } from '@/api/apiSession';

interface CursorAgentMode {
  permissionMode: string;
  model?: string;
}

/**
 * Inject happy MCP server into the workspace .cursor/mcp.json
 * Returns a cleanup function to remove the injected entry.
 */
function injectHappyMcp(cwd: string, mcpUrl: string): () => void {
  const cursorDir = join(cwd, '.cursor');
  const mcpPath = join(cursorDir, 'mcp.json');

  let original: string | null = null;
  let existing: Record<string, unknown> = { mcpServers: {} };

  if (existsSync(mcpPath)) {
    try {
      original = readFileSync(mcpPath, 'utf-8');
      existing = JSON.parse(original);
    } catch {
      existing = { mcpServers: {} };
    }
  } else {
    mkdirSync(cursorDir, { recursive: true });
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  const updated = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      happy: {
        command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
        args: ['--url', mcpUrl],
      },
    },
  };

  writeFileSync(mcpPath, JSON.stringify(updated, null, 2), 'utf-8');
  logger.debug(`[cursor-agent] Injected happy MCP server into ${mcpPath}`);

  return () => {
    try {
      if (original === null) {
        // We created the file, remove the happy entry only
        const current = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        const servers = current.mcpServers as Record<string, unknown>;
        delete servers.happy;
        if (Object.keys(servers).length === 0) {
          // Remove file if empty
          const { unlinkSync } = require('fs');
          unlinkSync(mcpPath);
        } else {
          writeFileSync(mcpPath, JSON.stringify(current, null, 2), 'utf-8');
        }
      } else {
        writeFileSync(mcpPath, original, 'utf-8');
      }
      logger.debug(`[cursor-agent] Restored ${mcpPath}`);
    } catch (e) {
      logger.debug(`[cursor-agent] Failed to restore mcp.json:`, e);
    }
  };
}

/**
 * Run cursor-agent with a prompt and collect stream-json output lines.
 */
function spawnCursorAgent(opts: {
  prompt: string;
  chatId: string | null;
  model?: string;
  cwd: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}): void {
  const args: string[] = ['--print', '--output-format', 'stream-json', '--approve-mcps'];

  if (opts.chatId) {
    args.push('--resume', opts.chatId);
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  args.push(opts.prompt);

  logger.debug(`[cursor-agent] Spawning: cursor-agent ${args.join(' ')}`);

  const child = spawn('cursor-agent', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    signal: opts.signal,
    windowsHide: true,
  });

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', opts.onLine);

  child.stderr?.on('data', (chunk: Buffer) => {
    logger.debug(`[cursor-agent:stderr] ${chunk.toString().trim()}`);
  });

  child.on('exit', (code) => {
    rl.close();
    opts.onExit(code);
  });

  child.on('error', (err) => {
    logger.debug(`[cursor-agent] spawn error:`, err);
    opts.onExit(null);
  });
}

export async function runCursorAgent(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  model?: string;
}): Promise<void> {
  // Check cursor-agent is installed
  try {
    execSync('cursor-agent --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  } catch {
    console.error('\n\x1b[1m\x1b[33mcursor-agent is not installed\x1b[0m\n');
    console.error('Please install Cursor Agent:\n');
    console.error('  \x1b[36mnpm install -g cursor-agent\x1b[0m\n');
    console.error('Or download from https://cursor.com\n');
    process.exit(1);
  }

  connectionState.setBackend('Cursor Agent');

  const sessionTag = randomUUID();
  const api = await ApiClient.create(opts.credentials);

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error('[START] No machine ID found in settings.');
    process.exit(1);
  }

  await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });

  const { state, metadata } = createSessionMetadata({
    flavor: 'cursor-agent',
    machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata);
    } catch (e) {
      logger.debug('[cursor-agent] Failed to notify daemon:', e);
    }
  }

  // Start happy MCP server and inject into workspace mcp.json
  const happyServer = await startHappyServer(session);
  const cleanupMcp = injectHappyMcp(process.cwd(), happyServer.url);

  // Create a new cursor-agent chat session
  let chatId: string | null = null;
  try {
    chatId = execSync('cursor-agent create-chat', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    logger.debug(`[cursor-agent] Created chat: ${chatId}`);
  } catch (e) {
    logger.debug('[cursor-agent] Failed to create chat, will start fresh:', e);
  }

  const messageQueue = new MessageQueue2<CursorAgentMode>(
    (mode) => hashObject({ permissionMode: mode.permissionMode, model: mode.model }),
  );

  let currentPermissionMode = 'default';
  let currentModel = opts.model;
  let thinking = false;
  let shouldExit = false;
  let abortController = new AbortController();

  session.onUserMessage((message) => {
    if (!message.content.text) return;

    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
    }
    if (message.meta?.model) {
      currentModel = message.meta.model as string;
    }

    messageQueue.push(message.content.text, {
      permissionMode: currentPermissionMode,
      model: currentModel,
    });
  });

  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    abortController.abort();
    messageQueue.reset();
    abortController = new AbortController();
  }

  async function handleKillSession() {
    shouldExit = true;
    messageQueue.close();
    abortController.abort();

    try {
      session.updateMetadata((m) => ({
        ...m,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'User terminated',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch {}

    happyServer.stop();
    cleanupMcp();
    process.exit(0);
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Emit ready
  const emitReady = () => {
    session.sendSessionEvent({ type: 'ready' });
  };

  // Initial ready
  emitReady();

  try {
    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);

      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      const prompt = batch.message;
      const model = batch.mode.model;

      // Show the user message in console
      console.log(`\x1b[36m[You]\x1b[0m ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);

      thinking = true;
      session.keepAlive(thinking, 'remote');

      // Use 'codex' as provider so the mobile app can render messages
      // (cursor-agent uses the same stream-json format as codex)
      session.sendAgentMessage('codex', {
        type: 'task_started',
        id: randomUUID(),
      });

      let accumulatedText = '';
      let turnChatId: string | null = null;

      await new Promise<void>((resolve) => {
        spawnCursorAgent({
          prompt,
          chatId,
          model,
          cwd: process.cwd(),
          signal: abortController.signal,
          onLine: (line) => {
            if (!line.trim()) return;
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(line);
            } catch {
              return;
            }

            const type = msg.type as string;

            // Extract session_id (chatId) from any message
            if (msg.session_id && typeof msg.session_id === 'string' && !turnChatId) {
              turnChatId = msg.session_id;
            }

            if (type === 'assistant') {
              const content = (msg.message as any)?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    accumulatedText += block.text;
                    // Stream partial output to console
                    process.stdout.write(block.text);
                  }
                }
              }
            } else if (type === 'tool_use' || type === 'tool-call') {
              const name = (msg.name as string) || (msg.tool_name as string) || 'tool';
              session.sendAgentMessage('codex', {
                type: 'tool-call',
                name,
                callId: (msg.id as string) || randomUUID(),
                input: msg.input ?? msg.args ?? {},
                id: randomUUID(),
              });
            } else if (type === 'tool_result' || type === 'tool-result') {
              session.sendAgentMessage('codex', {
                type: 'tool-result',
                callId: (msg.tool_use_id as string) || (msg.callId as string) || randomUUID(),
                output: msg.content ?? msg.result ?? '',
                id: randomUUID(),
              });
            } else if (type === 'system' && (msg.subtype as string) === 'init') {
              logger.debug(`[cursor-agent] session_id=${msg.session_id} model=${msg.model}`);
            } else if (type === 'result') {
              // Final result — will be handled in onExit
            }
          },
          onExit: (code) => {
            process.stdout.write('\n');
            resolve();
          },
        });
      });

      // Update chatId for next turn
      if (turnChatId) {
        chatId = turnChatId;
      }

      // Send accumulated text as a complete message
      if (accumulatedText.trim()) {
        session.sendAgentMessage('codex', {
          type: 'message',
          message: accumulatedText,
        });
      }

      session.sendAgentMessage('codex', {
        type: 'task_complete',
        id: randomUUID(),
      });

      thinking = false;
      session.keepAlive(thinking, 'remote');
      emitReady();
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch {}

    happyServer.stop();
    cleanupMcp();
  }
}
