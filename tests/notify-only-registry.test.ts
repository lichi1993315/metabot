import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createNotifyOnlyRegistry } from '../src/notify/notify-only-registry.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

const config = (): AppConfig => ({
  feishuBots: [
    {
      name: 'metabot',
      feishu: { appId: 'test-id', appSecret: 'test-value' },
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
    },
  ],
  telegramBots: [{ name: 'telegram', telegram: { botToken: 'test-value' }, claude: {} as any }],
  webBots: [{ name: 'web', claude: {} as any }],
  wechatBots: [{ name: 'wechat', wechat: { botToken: 'test-value' }, claude: {} as any }],
  log: { level: 'silent' },
  api: { port: 9100, secret: 'test-value' },
  peers: [],
  agentTeams: [],
});

describe('notify-only registry', () => {
  it('creates outbound Feishu senders without starting websocket clients', async () => {
    const clientFactory = vi.fn().mockReturnValue({
      im: { v1: { message: { create: vi.fn() } } },
    });

    const registry = await createNotifyOnlyRegistry(config(), logger(), clientFactory);

    expect(registry.get('metabot')?.sender).toBeDefined();
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory.mock.calls[0]?.[0]).toEqual({ appId: 'test-id', appSecret: 'test-value' });
  });

  it('does not register telegram, web, or wechat bots', async () => {
    const registry = await createNotifyOnlyRegistry(
      config(),
      logger(),
      vi.fn().mockReturnValue({ im: { v1: { message: {} } } }),
    );

    expect(registry.names()).toEqual(['metabot']);
    expect(registry.get('telegram')).toBeUndefined();
    expect(registry.get('web')).toBeUndefined();
    expect(registry.get('wechat')).toBeUndefined();
  });
});
