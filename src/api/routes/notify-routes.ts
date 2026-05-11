import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

const VALID_COLORS = new Set(['blue', 'green', 'red', 'orange', 'yellow', 'grey', 'purple', 'wathet']);
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEDUPE_KEYS = 5000;

const dedupeCache = new Map<string, number>();

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function colorField(value: unknown): string {
  const color = textField(value).toLowerCase();
  return VALID_COLORS.has(color) ? color : 'blue';
}

function cardField(value: unknown): { content?: string; error?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value === 'string') {
    const content = value.trim();
    if (!content) return {};
    try {
      JSON.parse(content);
    } catch {
      return { error: 'card must be valid JSON' };
    }
    return { content };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'card must be a JSON object or JSON string' };
  }
  return { content: JSON.stringify(value) };
}

function hasRecentDedupeKey(key: string, now: number): boolean {
  const seenAt = dedupeCache.get(key);
  return Boolean(seenAt && now - seenAt < DEDUPE_TTL_MS);
}

function rememberDedupeKey(key: string, now: number): void {
  dedupeCache.set(key, now);
  if (dedupeCache.size > MAX_DEDUPE_KEYS) {
    for (const [cachedKey, cachedAt] of dedupeCache) {
      if (now - cachedAt >= DEDUPE_TTL_MS || dedupeCache.size > MAX_DEDUPE_KEYS) {
        dedupeCache.delete(cachedKey);
      }
      if (dedupeCache.size <= MAX_DEDUPE_KEYS) break;
    }
  }
}

export function clearNotifyDedupeCacheForTests(): void {
  dedupeCache.clear();
}

export async function handleNotifyRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'POST' || url !== '/api/notify') {
    return false;
  }

  const body = await parseJsonBody(req);
  const botName = textField(body.botName);
  const chatId = textField(body.chatId);
  const title = textField(body.title);
  const content = textField(body.content);
  const text = textField(body.text);
  const dedupeKey = textField(body.dedupeKey);
  const mode = textField(body.mode);
  const color = colorField(body.color);
  const card = cardField(body.card ?? body.cardContent);

  if (!botName || !chatId) {
    jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId' });
    return true;
  }
  if (card.error) {
    jsonResponse(res, 400, { error: card.error });
    return true;
  }
  if (mode === 'card' && !card.content) {
    jsonResponse(res, 400, { error: 'Provide card' });
    return true;
  }
  if (!card.content && !content && !text) {
    jsonResponse(res, 400, { error: 'Provide card, content, or text' });
    return true;
  }

  const bot = ctx.registry.get(botName);
  if (!bot) {
    jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
    return true;
  }

  if (dedupeKey && hasRecentDedupeKey(dedupeKey, Date.now())) {
    jsonResponse(res, 200, { success: true, deduped: true });
    return true;
  }

  try {
    let messageId: string | undefined;
    if (card.content) {
      if (!bot.sender.sendRawCard) {
        jsonResponse(res, 400, { error: `Bot does not support raw card delivery: ${botName}` });
        return true;
      }
      messageId = await bot.sender.sendRawCard(chatId, card.content);
      if (!messageId) {
        throw new Error('Card delivery did not return a message_id');
      }
    } else if (mode === 'text' || !title) {
      await bot.sender.sendText(chatId, text || content);
    } else {
      await bot.sender.sendTextNotice(chatId, title, content || text, color);
    }
    if (dedupeKey) {
      rememberDedupeKey(dedupeKey, Date.now());
    }
  } catch (err: any) {
    ctx.logger.error({ err, botName, chatId, dedupeKey }, 'Notify route delivery failed');
    jsonResponse(res, 502, { error: err.message || 'Notification delivery failed' });
    return true;
  }

  ctx.logger.info(
    {
      botName,
      chatId,
      dedupeKey: dedupeKey || undefined,
      source: textField(body.source) || undefined,
      eventType: textField(body.eventType) || undefined,
      deliveryType: card.content ? 'card' : mode === 'text' || !title ? 'text' : 'notice',
    },
    'Notification delivered',
  );
  jsonResponse(res, 200, { success: true });
  return true;
}
