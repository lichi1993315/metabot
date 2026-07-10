import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../src/config.js';
import { isNotifyOnlyMode, runNotifyOnlyRuntime } from '../src/notify/notify-only-runtime.js';

const appConfig = (): AppConfig => ({
  feishuBots: [],
  telegramBots: [],
  webBots: [],
  wechatBots: [],
  log: { level: 'silent' },
  api: { port: 9100, secret: 'test-secret' },
  peers: [],
  agentTeams: [],
});

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

describe('notify-only runtime', () => {
  it('accepts only the explicit true flag', () => {
    expect(isNotifyOnlyMode({ METABOT_NOTIFY_ONLY: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isNotifyOnlyMode({ METABOT_NOTIFY_ONLY: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isNotifyOnlyMode({ METABOT_NOTIFY_ONLY: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isNotifyOnlyMode({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('starts only the outbound registry and minimal server', async () => {
    const server = Object.assign(new EventEmitter(), {
      close: vi.fn((callback?: () => void) => callback?.()),
    }) as any;
    const deps = {
      createRegistry: vi.fn().mockResolvedValue({ names: () => ['metabot'], get: vi.fn() }),
      startServer: vi.fn().mockReturnValue(server),
      registerSignal: vi.fn(),
      startFeishuBot: vi.fn(),
      startTelegramBot: vi.fn(),
      startWechatBot: vi.fn(),
      createTaskScheduler: vi.fn(),
      createPeerManager: vi.fn(),
    } as any;

    const runtime = await runNotifyOnlyRuntime(appConfig(), logger(), deps);

    expect(deps.createRegistry).toHaveBeenCalledOnce();
    expect(deps.startServer).toHaveBeenCalledOnce();
    expect(deps.startFeishuBot).not.toHaveBeenCalled();
    expect(deps.startTelegramBot).not.toHaveBeenCalled();
    expect(deps.startWechatBot).not.toHaveBeenCalled();
    expect(deps.createTaskScheduler).not.toHaveBeenCalled();
    expect(deps.createPeerManager).not.toHaveBeenCalled();
    await runtime.shutdown();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('fails closed when no outbound Feishu bot is configured', async () => {
    await expect(
      runNotifyOnlyRuntime(appConfig(), logger(), {
        createRegistry: vi.fn().mockResolvedValue({ names: () => [], get: vi.fn() }),
        startServer: vi.fn(),
        registerSignal: vi.fn(),
      }),
    ).rejects.toThrow(/Feishu bot/i);
  });
});
