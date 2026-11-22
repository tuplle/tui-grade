import { parseArgs } from 'node:util';
import { rescoreRun } from '../../core/rescore.ts';
import { resolveUserPath } from '../../core/paths.ts';
import { stripControl } from '../../core/text.ts';
import { formatNumber } from '../../plugins/reporter-shared.ts';
import { type Command, UsageError, USAGE, formatIssue, positionalArgs } from '../common.ts';

const LOCALES = ['en', 'sk'] as const;

export const rescoreCommand: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      manual: { type: 'string' },
      locale: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [assignmentDir, outDir] = positionalArgs('rescore', positionals, 2, 2) as [string, string];
  const locale = LOCALES.find((l) => l === values.locale);
  if (values.locale !== undefined && locale === undefined) throw new UsageError(`--locale must be one of: ${LOCALES.join(', ')}`);

  const cwd = io.cwd ?? process.cwd();
  const resolvedOut = resolveUserPath(outDir, cwd);
  const { results, issues } = await rescoreRun({
    assignmentDir: resolveUserPath(assignmentDir, cwd),
    outDir: resolvedOut,
    ...(values.manual === undefined ? {} : { manualFile: resolveUserPath(values.manual, cwd) }),
    ...(locale === undefined ? {} : { locale }),
  });
  for (const issue of issues) io.stderr.write(`${formatIssue(issue)}\n`);
  for (const result of results) {
    for (const warning of result.warnings) io.stderr.write(`[${result.student.id}] warning: ${stripControl(warning)}\n`);
  }
  const width = Math.max('Student'.length, ...results.map((result) => result.student.id.length));
  io.stdout.write(`${'Student'.padEnd(width)}  Points\n`);
  for (const result of results) {
    io.stdout.write(`${result.student.id.padEnd(width)}  ${formatNumber(result.score.points)} / ${formatNumber(result.score.max)}\n`);
  }
  io.stdout.write(`\n${results.length} submission${results.length === 1 ? '' : 's'} rescored in ${resolvedOut}\n`);
  return 0;
};
