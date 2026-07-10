import * as lark from '@larksuiteoapi/node-sdk';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { AppConfig } from '../config.js';
import { FeishuSenderAdapter } from '../feishu/feishu-sender-adapter.js';
import { MessageSender } from '../feishu/message-sender.js';
import type { Logger } from '../utils/logger.js';

export interface NotifyOnlyRegistryEntry {
  name: string;
  sender: IMessageSender;
}

export interface NotifyOnlyRegistry {
  get(name: string): NotifyOnlyRegistryEntry | undefined;
  names(): string[];
}

export type NotifyOnlyClientFactory = (credentials: {
  appId: string;
  appSecret: string;
}) => lark.Client;

const defaultClientFactory: NotifyOnlyClientFactory = ({ appId, appSecret }) =>
  new lark.Client({ appId, appSecret });

export async function createNotifyOnlyRegistry(
  config: AppConfig,
  logger: Logger,
  clientFactory: NotifyOnlyClientFactory = defaultClientFactory,
): Promise<NotifyOnlyRegistry> {
  const entries = new Map<string, NotifyOnlyRegistryEntry>();
  for (const bot of config.feishuBots) {
    if (entries.has(bot.name)) {
      throw new Error(`Duplicate notify-only bot name: ${bot.name}`);
    }
    const client = clientFactory({
      appId: bot.feishu.appId,
      appSecret: bot.feishu.appSecret,
    });
    entries.set(bot.name, {
      name: bot.name,
      sender: new FeishuSenderAdapter(new MessageSender(client, logger)),
    });
  }
  logger.info({ bots: [...entries.keys()] }, 'Notify-only outbound registry ready');
  return {
    get: (name: string) => entries.get(name),
    names: () => [...entries.keys()],
  };
}
