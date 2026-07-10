import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskScheduler } from '../src/scheduler/task-scheduler.js';
import type { BotRegistry } from '../src/api/bot-registry.js';
import type { Logger } from '../src/utils/logger.js';

// Mock cron-utils to return deterministic values
vi.mock('../src/scheduler/cron-utils.js', () => ({
  isValidCron: (expr: string) => {
    const invalid = ['invalid', '', '0 8 * *', '60 8 * * *'];
    return !invalid.includes(expr);
  },
  nextCronOccurrence: vi.fn(() => Date.now() + 60_000), // default: 1 min from now
  getDefaultTimezone: () => 'Asia/Shanghai',
}));

// Get reference to the mock so we can change return values
import { nextCronOccurrence } from '../src/scheduler/cron-utils.js';
const mockNextCron = vi.mocked(nextCronOccurrence);

const PERSIST_DIR = path.join(os.homedir(), '.metabot');
const PERSIST_FILE = path.join(PERSIST_DIR, 'scheduled-tasks.json');

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createMockRegistry(botExists = true, isBusy = false): BotRegistry {
  const mockBridge = {
    isBusy: vi.fn().mockReturnValue(isBusy),
    executeApiTask: vi.fn().mockResolvedValue({ success: true }),
  };
  const mockSender = {
    sendTextNotice: vi.fn().mockResolvedValue(undefined),
  };
  const mockBot = {
    bridge: mockBridge,
    sender: mockSender,
    config: { claude: { defaultWorkingDirectory: '/tmp' } },
  };
  return {
    get: vi.fn().mockReturnValue(botExists ? mockBot : undefined),
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    deregister: vi.fn(),
  } as unknown as BotRegistry;
}

describe('TaskScheduler - Recurring Tasks', () => {
  let originalPersist: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Save and clear any existing persist file
    try {
      originalPersist = fs.readFileSync(PERSIST_FILE, 'utf-8');
    } catch {
      originalPersist = undefined;
    }
    try { fs.unlinkSync(PERSIST_FILE); } catch { /* ignore */ }
    mockNextCron.mockImplementation(() => Date.now() + 60_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore persist file
    try { fs.unlinkSync(PERSIST_FILE); } catch { /* ignore */ }
    if (originalPersist) {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
      fs.writeFileSync(PERSIST_FILE, originalPersist);
    }
  });

  it('creates a recurring task with correct fields', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'testbot',
      chatId: 'chat1',
      prompt: 'Read news',
      cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      label: 'Daily news',
    });

    expect(recurring.id).toBeTruthy();
    expect(recurring.botName).toBe('testbot');
    expect(recurring.chatId).toBe('chat1');
    expect(recurring.prompt).toBe('Read news');
    expect(recurring.cronExpr).toBe('0 8 * * *');
    expect(recurring.timezone).toBe('Asia/Shanghai');
    expect(recurring.status).toBe('active');
    expect(recurring.label).toBe('Daily news');
    expect(recurring.sendCards).toBe(true);
    expect(recurring.nextExecuteAt).toBeGreaterThan(0);

    scheduler.destroy();
  });

  it('throws for invalid cron expression', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    expect(() => scheduler.scheduleRecurring({
      botName: 'testbot',
      chatId: 'chat1',
      prompt: 'test',
      cronExpr: 'invalid',
    })).toThrow('Invalid cron expression');
    scheduler.destroy();
  });

  it('uses default timezone when not specified', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'testbot',
      chatId: 'chat1',
      prompt: 'test',
      cronExpr: '0 8 * * *',
    });

    expect(recurring.timezone).toBe('Asia/Shanghai');
    scheduler.destroy();
  });

  it('lists recurring tasks (excluding cancelled)', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    scheduler.scheduleRecurring({ botName: 'b', chatId: 'c', prompt: 'p1', cronExpr: '0 8 * * *' });
    scheduler.scheduleRecurring({ botName: 'b', chatId: 'c', prompt: 'p2', cronExpr: '0 9 * * *' });

    expect(scheduler.listRecurringTasks()).toHaveLength(2);
    expect(scheduler.recurringTaskCount()).toBe(2);

    scheduler.destroy();
  });

  it('pauses and resumes a recurring task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *',
    });

    expect(scheduler.pauseRecurring(recurring.id)).toBe(true);
    const paused = scheduler.getRecurringTask(recurring.id);
    expect(paused?.status).toBe('paused');

    // Cannot pause again
    expect(scheduler.pauseRecurring(recurring.id)).toBe(false);

    expect(scheduler.resumeRecurring(recurring.id)).toBe(true);
    const resumed = scheduler.getRecurringTask(recurring.id);
    expect(resumed?.status).toBe('active');

    // Cannot resume again
    expect(scheduler.resumeRecurring(recurring.id)).toBe(false);

    scheduler.destroy();
  });

  it('cancels a recurring task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *',
    });

    expect(scheduler.cancelRecurring(recurring.id)).toBe(true);
    expect(scheduler.getRecurringTask(recurring.id)?.status).toBe('cancelled');
    expect(scheduler.listRecurringTasks()).toHaveLength(0);

    // Cannot cancel again
    expect(scheduler.cancelRecurring(recurring.id)).toBe(false);

    scheduler.destroy();
  });

  it('updates a recurring task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'old', cronExpr: '0 8 * * *', label: 'old',
    });

    const updated = scheduler.updateRecurring(recurring.id, {
      prompt: 'new prompt',
      label: 'new label',
    });

    expect(updated?.prompt).toBe('new prompt');
    expect(updated?.label).toBe('new label');
    expect(updated?.cronExpr).toBe('0 8 * * *'); // unchanged

    scheduler.destroy();
  });

  it('rejects updating with invalid cron', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const recurring = scheduler.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *',
    });

    expect(() => scheduler.updateRecurring(recurring.id, { cronExpr: 'invalid' }))
      .toThrow('Invalid cron expression');

    scheduler.destroy();
  });

  it('fires recurring instance and schedules next', async () => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());

    // Mock: first call returns "now + 100ms", subsequent calls return "now + 60s"
    let callCount = 0;
    mockNextCron.mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? Date.now() + 100
        : Date.now() + 60_000;
    });

    const recurring = scheduler.scheduleRecurring({
      botName: 'testbot', chatId: 'chat1', prompt: 'Do work', cronExpr: '* * * * *',
    });

    // Advance past the first fire time
    await vi.advanceTimersByTimeAsync(200);

    // The recurring task should have fired: check the bridge was called
    const bot = (registry.get as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    if (bot) {
      expect(bot.bridge.executeApiTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Do work',
          chatId: 'chat1',
          userId: 'scheduler',
        }),
      );
    }

    // After firing, recurring should have updated lastExecutedAt and nextExecuteAt
    const updated = scheduler.getRecurringTask(recurring.id);
    expect(updated?.lastExecutedAt).toBeGreaterThan(0);
    expect(updated?.status).toBe('active');

    scheduler.destroy();
  });

  it('persists and restores recurring tasks across instances', () => {
    const logger = createMockLogger();
    const registry = createMockRegistry();

    // Create scheduler with recurring task
    const scheduler1 = new TaskScheduler(registry, logger);
    const recurring = scheduler1.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *', label: 'test',
    });
    scheduler1.destroy();

    // New scheduler instance should restore it
    const scheduler2 = new TaskScheduler(registry, logger);
    const restored = scheduler2.listRecurringTasks();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(recurring.id);
    expect(restored[0].prompt).toBe('p');
    expect(restored[0].cronExpr).toBe('0 8 * * *');
    expect(restored[0].status).toBe('active');

    scheduler2.destroy();
  });

  it('marks executing recurring child failed on destroy', async () => {
    const logger = createMockLogger();
    const executeApiTask = vi.fn().mockReturnValue(new Promise(() => { /* keep task executing */ }));
    const registry = {
      get: vi.fn().mockReturnValue({
        bridge: {
          isBusy: vi.fn().mockReturnValue(false),
          executeApiTask,
        },
        sender: {
          sendTextNotice: vi.fn().mockResolvedValue(undefined),
        },
      }),
      list: vi.fn().mockReturnValue([]),
      register: vi.fn(),
      deregister: vi.fn(),
    } as unknown as BotRegistry;

    let callCount = 0;
    mockNextCron.mockImplementation(() => {
      callCount++;
      return Date.now() + (callCount === 1 ? 100 : 60_000);
    });

    const scheduler = new TaskScheduler(registry, logger);
    const recurring = scheduler.scheduleRecurring({
      botName: 'testbot', chatId: 'chat1', prompt: 'Do work', cronExpr: '* * * * *',
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(executeApiTask).toHaveBeenCalled();

    scheduler.destroy();

    const persisted = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
    const child = persisted.tasks.find((task: any) => task.parentRecurringId === recurring.id);
    const persistedRecurring = persisted.recurringTasks.find((task: any) => task.id === recurring.id);

    expect(child?.status).toBe('failed');
    expect(persistedRecurring?.currentChildId).toBeUndefined();
    expect(persistedRecurring?.nextExecuteAt).toBe(Date.now() + 60_000);
  });

  it('cleans interrupted recurring child state on restore and persists cleanup', () => {
    const now = Date.now();
    mockNextCron.mockReturnValue(now + 60_000);

    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      tasks: [
        {
          id: 'child-1',
          botName: 'b',
          chatId: 'c',
          prompt: 'p',
          executeAt: now - 1_000,
          sendCards: true,
          status: 'executing',
          createdAt: now - 1_000,
          retryCount: 0,
          parentRecurringId: 'recurring-1',
        },
      ],
      recurringTasks: [
        {
          id: 'recurring-1',
          botName: 'b',
          chatId: 'c',
          prompt: 'p',
          cronExpr: '0 23 * * *',
          timezone: 'Asia/Shanghai',
          sendCards: true,
          status: 'active',
          createdAt: now - 60_000,
          nextExecuteAt: now - 1_000,
          currentChildId: 'child-1',
        },
      ],
    }));

    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const restored = scheduler.getRecurringTask('recurring-1');
    const persisted = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
    const persistedRecurring = persisted.recurringTasks.find((task: any) => task.id === 'recurring-1');

    expect(restored?.currentChildId).toBeUndefined();
    expect(restored?.nextExecuteAt).toBe(now + 60_000);
    expect(scheduler.listTasks()).toHaveLength(0);
    expect(persisted.tasks).toHaveLength(0);
    expect(persistedRecurring?.currentChildId).toBeUndefined();
    expect(persistedRecurring?.nextExecuteAt).toBe(now + 60_000);

    scheduler.destroy();
  });

  it('backward-compatible: loads old array format persist file', () => {
    // Write old-format persist file (plain array)
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const oldData = [
      {
        id: 'old-task-1',
        botName: 'b',
        chatId: 'c',
        prompt: 'old task',
        executeAt: Date.now() + 60_000,
        sendCards: true,
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
      },
    ];
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(oldData));

    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());

    // One-time task should be restored
    expect(scheduler.listTasks()).toHaveLength(1);
    expect(scheduler.listTasks()[0].id).toBe('old-task-1');

    // No recurring tasks
    expect(scheduler.listRecurringTasks()).toHaveLength(0);

    scheduler.destroy();
  });

  it('does not restore cancelled recurring tasks', () => {
    const logger = createMockLogger();
    const registry = createMockRegistry();

    const scheduler1 = new TaskScheduler(registry, logger);
    const recurring = scheduler1.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *',
    });
    scheduler1.cancelRecurring(recurring.id);
    scheduler1.destroy();

    const scheduler2 = new TaskScheduler(registry, logger);
    expect(scheduler2.listRecurringTasks()).toHaveLength(0);
    scheduler2.destroy();
  });

  it('restores paused recurring tasks without setting timers', () => {
    const logger = createMockLogger();
    const registry = createMockRegistry();

    const scheduler1 = new TaskScheduler(registry, logger);
    const recurring = scheduler1.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'p', cronExpr: '0 8 * * *',
    });
    scheduler1.pauseRecurring(recurring.id);
    scheduler1.destroy();

    const scheduler2 = new TaskScheduler(registry, logger);
    const restored = scheduler2.listRecurringTasks();
    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe('paused');

    scheduler2.destroy();
  });

  it('one-time tasks still work alongside recurring tasks', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());

    const oneTime = scheduler.scheduleTask({
      botName: 'b', chatId: 'c', prompt: 'one-time', delaySeconds: 60,
    });
    const recurring = scheduler.scheduleRecurring({
      botName: 'b', chatId: 'c', prompt: 'recurring', cronExpr: '0 8 * * *',
    });

    expect(scheduler.listTasks()).toHaveLength(1);
    expect(scheduler.listTasks()[0].id).toBe(oneTime.id);
    expect(scheduler.listRecurringTasks()).toHaveLength(1);
    expect(scheduler.listRecurringTasks()[0].id).toBe(recurring.id);

    scheduler.destroy();
  });
});
