import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGrader } from '../../grader.ts';
import { defaultDataDir } from '../../core/data-dir.ts';
import { resolveUserPath } from '../../core/paths.ts';
import { isShuttingDown, shutdownExitCode } from '../../core/shutdown.ts';
import { stripControl } from '../../core/text.ts';
import { formatNumber } from '../../plugins/reporter-shared.ts';
import { type Command, UsageError, USAGE, formatIssue, positionalArgs } from '../common.ts';

const LOCALES = ['en', 'sk'] as const;

export const runCommand: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: 'string' },
      only: { type: 'string' },
      locale: { type: 'string' },
      manual: { type: 'string' },
      'keep-workdirs': { type: 'boolean' },
      'fail-under': { type: 'string' },
      events: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [assignmentDir, inputPath] = positionalArgs('run', positionals, 2, 2) as [string, string];

  const locale = LOCALES.find((l) => l === values.locale);
  if (values.locale !== undefined && locale === undefined) throw new UsageError(`--locale must be one of: ${LOCALES.join(', ')}`);
  const failUnderText = values['fail-under'];
  if (failUnderText !== undefined && !/^\d+(\.\d+)?$/.test(failUnderText)) {
    throw new UsageError(`--fail-under needs a non-negative decimal number such as 12 or 7.5, got '${failUnderText}'`);
  }
  const failUnder = failUnderText === undefined ? undefined : Number(failUnderText);
  const only = values.only?.split(',').map((id) => id.trim()).filter((id) => id !== '');
  if (only?.length === 0) throw new UsageError('--only needs at least one scenario id');

  const cwd = io.cwd ?? process.cwd();
  const outDir =
    values.out === undefined ? join(defaultDataDir(), new Date().toISOString().replaceAll(':', '-')) : resolveUserPath(values.out, cwd);

  const grader = createGrader({ assignmentDir: resolveUserPath(assignmentDir, cwd) });
  if (only !== undefined) {
    // Selecting nothing would grade every student 0; refuse before anything is created. An invalid assignment
    // is left to the run itself, which reports its issues.
    const { ok, scenarios } = await grader.inspect();
    const known = new Set(scenarios.map((s) => s.id));
    if (ok && !only.some((id) => known.has(id))) {
      const shown = [...known].slice(0, 20).join(', ');
      throw new Error(`--only matches no scenario (requested: ${only.join(', ')}; available: ${shown}${known.size > 20 ? ', ...' : ''})`);
    }
  }
  const { results, issues, outDir: written } = await grader.run({
    inputPath: resolveUserPath(inputPath, cwd),
    outDir,
    ...(only === undefined ? {} : { only }),
    ...(locale === undefined ? {} : { locale }),
    ...(values.manual === undefined ? {} : { manualFile: resolveUserPath(values.manual, cwd) }),
    ...(values['keep-workdirs'] === undefined ? {} : { keepWorkdirs: values['keep-workdirs'] }),
    log: (m) => io.stderr.write(`${stripControl(m)}\n`), // progress never goes into the student output directory
    ...(values.events === true ? { onEvent: (event) => io.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
  });

  for (const issue of issues) io.stderr.write(`${formatIssue(issue)}\n`);
  for (const result of results) {
    for (const warning of result.warnings) io.stderr.write(`[${result.student.id}] warning: ${stripControl(warning)}\n`);
  }

  if (isShuttingDown()) {
    // Stopped by Ctrl-C / SIGTERM: what was graded so far is partial (an interrupted submission carries a placeholder
    // score), so no table, no "graded" line and no --fail-under verdict; only the exit code of the signal.
    io.stderr.write('interrupted: results are incomplete\n');
    return shutdownExitCode();
  }

  if (values.events !== true) {
    const width = Math.max('Student'.length, ...results.map((r) => r.student.id.length));
    io.stdout.write(`${'Student'.padEnd(width)}  Points\n`);
    for (const r of results) {
      io.stdout.write(`${r.student.id.padEnd(width)}  ${formatNumber(r.score.points)} / ${formatNumber(r.score.max)}\n`);
    }
    io.stdout.write(`\n${results.length} submission${results.length === 1 ? '' : 's'} graded; results in ${written}\n`);
  }

  if (failUnder !== undefined) {
    const below = results.filter((r) => r.score.points < failUnder);
    if (below.length > 0) {
      io.stderr.write(`--fail-under ${formatNumber(failUnder)}: below the threshold: ${below.map((r) => r.student.id).join(', ')}\n`);
      return 2;
    }
  }
  return 0;
};
