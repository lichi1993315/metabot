import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyOnlyRegistry } from '../src/notify/notify-only-registry.js';
import { startNotifyOnlyServer } from '../src/notify/notify-only-server.js';

const servers: http.Server[] = [];

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

const registry = (sender: any): NotifyOnlyRegistry => ({
  get: (name) => (name === 'metabot' ? { name, sender } : undefined),
  names: () => ['metabot'],
});

const sender = () => ({
  sendTextNotice: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  sendRawCard: vi.fn().mockResolvedValue('message-id'),
});

async function startTestServer(customSender = sender()): Promise<http.Server> {
  const server = startNotifyOnlyServer({
    port: 0,
    secret: 'test-secret',
    registry: registry(customSender),
    logger: logger(),
  });
  servers.push(server);
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve));
  }
  return server;
}

async function request(
  server: http.Server,
  method: string,
  path: string,
  body?: object,
  authorization?: string,
): Promise<{ status: number; body: any }> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const validPayload = () => ({
  botName: 'metabot',
  chatId: 'oc-chat',
  title: 'Memory warning',
  content: 'Host memory reached threshold',
});

afterEach(async () => {
  delete process.env.METABOT_RATE_LIMIT_AUTH_FAILS;
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('notify-only server', () => {
  it('exposes health but rejects unauthenticated notify', async () => {
    const server = await startTestServer();

    expect(await request(server, 'GET', '/api/health')).toMatchObject({
      status: 200,
      body: { status: 'ok', mode: 'notify-only' },
    });
    expect((await request(server, 'POST', '/api/notify', validPayload())).status).toBe(401);
  });

  it('delivers authenticated notify and rejects every other route', async () => {
    const server = await startTestServer();

    expect((await request(server, 'POST', '/api/notify', validPayload(), 'Bearer test-secret')).status).toBe(200);
    expect((await request(server, 'GET', '/api/status', undefined, 'Bearer test-secret')).status).toBe(404);
    expect((await request(server, 'POST', '/api/tasks', {}, 'Bearer test-secret')).status).toBe(404);
  });

  it('uses failed-auth lockout and timing-safe wrong-secret rejection', async () => {
    process.env.METABOT_RATE_LIMIT_AUTH_FAILS = '2';
    const server = await startTestServer();

    expect((await request(server, 'POST', '/api/notify', validPayload(), 'Bearer wrong')).status).toBe(401);
    expect((await request(server, 'POST', '/api/notify', validPayload(), 'Bearer wrong')).status).toBe(401);
    expect((await request(server, 'POST', '/api/notify', validPayload(), 'Bearer test-secret')).status).toBe(429);
  });

  it('fails closed without a secret and maps sender failure to 502', async () => {
    expect(() =>
      startNotifyOnlyServer({ port: 0, secret: '', registry: registry(sender()), logger: logger() }),
    ).toThrow(/secret/i);
    const failingSender = sender();
    failingSender.sendTextNotice.mockRejectedValue(new Error('delivery failed'));
    const server = await startTestServer(failingSender);

    expect((await request(server, 'POST', '/api/notify', validPayload(), 'Bearer test-secret')).status).toBe(502);
  });
});
