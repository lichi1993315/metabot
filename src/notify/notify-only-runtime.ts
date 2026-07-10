import type * as http from 'node:http';
import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import {
  createNotifyOnlyRegistry,
  type NotifyOnlyRegistry,
} from './notify-only-registry.js';
import {
  startNotifyOnlyServer,
  type NotifyOnlyServerOptions,
} from './notify-only-server.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface NotifyOnlyRuntimeDependencies {
  createRegistry?: (
    config: AppConfig,
    logger: Logger,
  ) => Promise<NotifyOnlyRegistry>;
  startServer?: (options: NotifyOnlyServerOptions) => http.Server;
  registerSignal?: (signal: ShutdownSignal, handler: () => void) => void;
}

export interface NotifyOnlyRuntimeHandle {
  server: http.Server;
  shutdown(): Promise<void>;
}

export function isNotifyOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.METABOT_NOTIFY_ONLY === 'true';
}

export async function runNotifyOnlyRuntime(
  appConfig: AppConfig,
  logger: Logger,
  dependencies: NotifyOnlyRuntimeDependencies = {},
): Promise<NotifyOnlyRuntimeHandle> {
  const secret = appConfig.api.secret?.trim();
  if (!secret) {
    throw new Error('Notify-only runtime requires API_SECRET');
  }
  const createRegistry = dependencies.createRegistry ?? createNotifyOnlyRegistry;
  const registry = await createRegistry(appConfig, logger);
  if (registry.names().length === 0) {
    throw new Error('Notify-only runtime requires at least one Feishu bot');
  }
  const startServer = dependencies.startServer ?? startNotifyOnlyServer;
  const server = startServer({
    port: appConfig.api.port,
    secret,
    registry,
    logger,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return shutdownPromise;
  };
  const registerSignal = dependencies.registerSignal
    ?? ((signal: ShutdownSignal, handler: () => void) => process.once(signal, handler));
  const onSignal = () => {
    logger.info({ mode: 'notify-only' }, 'Shutting down notify-only runtime');
    void shutdown()
      .then(() => { process.exitCode = 0; })
      .catch((error) => {
        logger.error({ error }, 'Notify-only shutdown failed');
        process.exitCode = 1;
      });
  };
  registerSignal('SIGINT', onSignal);
  registerSignal('SIGTERM', onSignal);
  logger.info({ bots: registry.names() }, 'MetaBot notify-only runtime started');
  return { server, shutdown };
}
