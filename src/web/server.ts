import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorHandler, localHostOnly, rejectPreflight, sameOriginWrites, securityHeaders } from './security.ts';
import { createApiRouter } from './routes.ts';
import { RunManager } from './run-manager.ts';

export interface AppDeps {
  resultsRoot: string;
  manager: RunManager;
  shutdown(): void;
  initial?: { assignmentDir?: string; inputPath?: string };
}

export interface StartServerOptions {
  resultsRoot: string;
  port?: number;
  initial?: { assignmentDir?: string; inputPath?: string };
}

export interface StartedServer {
  app: Express;
  server: Server;
  manager: RunManager;
  url: string;
  close(): Promise<void>;
}

function publicDir(): string {
  const built = fileURLToPath(new URL('../../dist/web/public', import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL('./public', import.meta.url));
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(rejectPreflight, securityHeaders, localHostOnly, sameOriginWrites);
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', createApiRouter(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } });
  });

  const dir = publicDir();
  if (existsSync(dir)) app.use(express.static(dir, { index: 'index.html', etag: false, maxAge: 0 }));
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(errorHandler);
  return app;
}

export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const port = options.port ?? 3333;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  const manager = new RunManager(options.resultsRoot);
  let closeServer: () => void = () => {};
  const app = createApp({
    resultsRoot: manager.resultsRoot,
    manager,
    shutdown: () => closeServer(),
    ...(options.initial === undefined ? {} : { initial: options.initial }),
  });
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/`;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        await manager.stopAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
    }
    return closing;
  };
  closeServer = () => {
    void close();
  };
  return { app, server, manager, url, close };
}
