import { parseArgs } from 'node:util';
import { defaultDataDir } from '../../core/data-dir.ts';
import { resolveUserPath } from '../../core/paths.ts';
import { openBrowser } from '../../web/open-browser.ts';
import { startServer } from '../../web/server.ts';
import { type Command, UsageError, USAGE } from '../common.ts';

export const serveCommand: Command = async (args, io) => {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      port: { type: 'string' },
      'results-root': { type: 'string' },
      assignment: { type: 'string' },
      submissions: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const port = values.port === undefined ? 3333 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be an integer between 0 and 65535`);
  const cwd = io.cwd ?? process.cwd();
  const resultsRoot = resolveUserPath(values['results-root'] ?? defaultDataDir(), cwd);

  const server = await startServer({
    resultsRoot,
    port,
    initial: {
      ...(values.assignment === undefined ? {} : { assignmentDir: resolveUserPath(values.assignment, cwd) }),
      ...(values.submissions === undefined ? {} : { inputPath: resolveUserPath(values.submissions, cwd) }),
    },
  });

  io.stdout.write(`tui-grade web UI: ${server.url}\n`);
  io.stdout.write(`Results: ${server.manager.resultsRoot}\n`);
  io.stdout.write('Press Ctrl+C to stop.\n');
  if (values['no-open'] !== true && process.stdout.isTTY === true) openBrowser(server.url);

  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) {
      process.exit(code);
      return;
    }
    stopping = true;
    void server.close().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  return 0;
};
