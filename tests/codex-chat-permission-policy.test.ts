import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfigBase, CodexBotConfig } from '../src/config.js';
import { loadAppConfig } from '../src/config.js';
import { CodexExecutor } from '../src/engines/codex/executor.js';
import { resolveCodexChatConfig } from '../src/engines/codex/chat-permission-policy.js';
import type { Logger } from '../src/utils/logger.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const makeBotConfig = (codex: CodexBotConfig): BotConfigBase => ({
  name: 'metabot',
  engine: 'codex',
  codex,
  claude: {
    defaultWorkingDirectory: '/tmp',
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    model: undefined,
    apiKey: undefined,
    outputsBaseDir: '/tmp',
    downloadsDir: '/tmp',
    backend: 'pty',
  },
});

describe('resolveCodexChatConfig', () => {
  it('leaves bot-level Codex settings unchanged when no chat policy is configured', () => {
    const resolved = resolveCodexChatConfig({
      model: 'gpt-test',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dangerouslyBypassApprovalsAndSandbox: true,
    }, 'oc_readonly');

    expect(resolved.policySource).toBe('none');
    expect(resolved.config).toEqual({
      model: 'gpt-test',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it('applies the default chat policy and disables global bypass unless the policy explicitly allows it', () => {
    const resolved = resolveCodexChatConfig({
      dangerouslyBypassApprovalsAndSandbox: true,
      chatPermissions: {
        default: {
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
      },
    }, 'oc_readonly');

    expect(resolved.policySource).toBe('default');
    expect(resolved.config.dangerouslyBypassApprovalsAndSandbox).toBe(false);
    expect(resolved.config.approvalPolicy).toBe('never');
    expect(resolved.config.sandbox).toBe('read-only');
  });

  it('lets an exact chat policy override the default policy', () => {
    const resolved = resolveCodexChatConfig({
      chatPermissions: {
        default: {
          sandbox: 'read-only',
        },
        chats: {
          oc_write: {
            sandbox: 'danger-full-access',
            dangerouslyBypassApprovalsAndSandbox: true,
          },
        },
      },
    }, 'oc_write');

    expect(resolved.policySource).toBe('chat');
    expect(resolved.config.sandbox).toBe('danger-full-access');
    expect(resolved.config.dangerouslyBypassApprovalsAndSandbox).toBe(true);
  });
});

describe('Codex chat permission config loading', () => {
  it('loads codex.chatPermissions from bots.json web bot entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-config-'));
    const configPath = join(dir, 'bots.json');
    const priorBotsConfig = process.env.BOTS_CONFIG;

    try {
      writeFileSync(configPath, JSON.stringify({
        webBots: [
          {
            name: 'web-codex',
            engine: 'codex',
            defaultWorkingDirectory: dir,
            codex: {
              chatPermissions: {
                default: {
                  approvalPolicy: 'never',
                  sandbox: 'read-only',
                },
                chats: {
                  oc_write: {
                    sandbox: 'danger-full-access',
                    dangerouslyBypassApprovalsAndSandbox: true,
                  },
                },
              },
            },
          },
        ],
      }));
      process.env.BOTS_CONFIG = configPath;

      const config = loadAppConfig();

      expect(config.webBots[0].codex?.chatPermissions).toEqual({
        default: {
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
        chats: {
          oc_write: {
            sandbox: 'danger-full-access',
            dangerouslyBypassApprovalsAndSandbox: true,
          },
        },
      });
    } finally {
      if (priorBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = priorBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CodexExecutor chat permissions', () => {
  it('spawns Codex with read-only sandbox for a read-only chat policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-chat-policy-'));
    const argvPath = join(dir, 'argv.json');
    const fakeCodex = join(dir, 'codex');
    writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.METABOT_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));
`);
    chmodSync(fakeCodex, 0o755);

    try {
      const executor = new CodexExecutor(makeBotConfig({
        executable: fakeCodex,
        dangerouslyBypassApprovalsAndSandbox: true,
        chatPermissions: {
          default: {
            approvalPolicy: 'never',
            sandbox: 'read-only',
          },
        },
        env: {
          METABOT_TEST_ARGV_PATH: argvPath,
        },
      }), logger);

      const handle = executor.startExecution({
        prompt: 'inspect only',
        cwd: dir,
        abortController: new AbortController(),
        apiContext: {
          botName: 'metabot',
          chatId: 'oc_readonly',
        },
      });
      for await (const _message of handle.stream) {
        // Drain stream until fake Codex exits.
      }

      const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[];
      expect(argv.slice(0, 4)).toEqual(['-a', 'never', '--sandbox', 'read-only']);
      expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
