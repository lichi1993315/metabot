import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type * as http from 'node:http';
import { clearNotifyDedupeCacheForTests, handleNotifyRoutes } from '../src/api/routes/notify-routes.js';

class TestResponse extends Writable {
  status = 0;
  headers: http.OutgoingHttpHeaders = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers: http.OutgoingHttpHeaders): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  json(): any {
    return JSON.parse(Buffer.concat(this.chunks).toString('utf-8'));
  }
}

function request(body: object): http.IncomingMessage {
  const payload = JSON.stringify(body);
  let sent = false;
  return new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(payload);
      this.push(null);
    },
  }) as http.IncomingMessage;
}

function context(sender: any): any {
  return {
    registry: {
      get: vi.fn().mockReturnValue({ sender }),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('notify routes', () => {
  afterEach(() => {
    clearNotifyDedupeCacheForTests();
  });

  it('delivers a generic notice without invoking an agent task', async () => {
    const sender = {
      sendTextNotice: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const res = new TestResponse();

    const handled = await handleNotifyRoutes(
      context(sender),
      request({
        botName: 'metabot',
        chatId: 'chat-1',
        title: 'Payment succeeded',
        content: 'Order pay_123 succeeded',
        color: 'green',
      }),
      res as unknown as http.ServerResponse,
      'POST',
      '/api/notify',
    );

    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat-1',
      'Payment succeeded',
      'Order pay_123 succeeded',
      'green',
    );
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('dedupes repeated notifications by key', async () => {
    const sender = {
      sendTextNotice: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = context(sender);

    const first = new TestResponse();
    await handleNotifyRoutes(
      ctx,
      request({ botName: 'metabot', chatId: 'chat-1', title: 'T', content: 'C', dedupeKey: 'k-1' }),
      first as unknown as http.ServerResponse,
      'POST',
      '/api/notify',
    );

    const second = new TestResponse();
    await handleNotifyRoutes(
      ctx,
      request({ botName: 'metabot', chatId: 'chat-1', title: 'T', content: 'C', dedupeKey: 'k-1' }),
      second as unknown as http.ServerResponse,
      'POST',
      '/api/notify',
    );

    expect(first.json()).toEqual({ success: true });
    expect(second.json()).toEqual({ success: true, deduped: true });
    expect(sender.sendTextNotice).toHaveBeenCalledTimes(1);
  });

  it('delivers a raw Feishu card when card payload is provided', async () => {
    const sender = {
      sendTextNotice: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRawCard: vi.fn().mockResolvedValue('om_1'),
    };
    const res = new TestResponse();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Dashboard' } },
      elements: [{ tag: 'markdown', content: '**OK**' }],
    };

    const handled = await handleNotifyRoutes(
      context(sender),
      request({
        botName: 'metabot',
        chatId: 'chat-1',
        mode: 'card',
        card,
      }),
      res as unknown as http.ServerResponse,
      'POST',
      '/api/notify',
    );

    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(sender.sendRawCard).toHaveBeenCalledWith('chat-1', JSON.stringify(card));
    expect(sender.sendTextNotice).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('rejects card mode for senders without raw card support', async () => {
    const sender = {
      sendTextNotice: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const res = new TestResponse();

    await handleNotifyRoutes(
      context(sender),
      request({
        botName: 'metabot',
        chatId: 'chat-1',
        mode: 'card',
        card: { config: {}, elements: [] },
      }),
      res as unknown as http.ServerResponse,
      'POST',
      '/api/notify',
    );

    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 'Bot does not support raw card delivery: metabot' });
  });
});
