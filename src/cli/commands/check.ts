import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGrader } from '../../grader.ts';
import { type Command, USAGE, positionalArgs, printIssues } from '../common.ts';

export const checkCommand: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { json: { type: 'boolean' }, list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [dir] = positionalArgs('check', positionals, 1, 1) as [string];
  const { ok, issues, scenarios } = await createGrader({ assignmentDir: resolve(io.cwd ?? process.cwd(), dir) }).inspect();

  if (values.json) {
    io.stdout.write(`${JSON.stringify({ ok, issues, scenarios }, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  printIssues(io, issues);
  if (values.list) {
    const width = Math.max(0, ...scenarios.map((s) => s.id.length));
    for (const s of scenarios) io.stdout.write(`${s.id.padEnd(width)}  ${s.title}\n`);
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  if (ok) {
    if (!values.list) io.stdout.write(`valid: ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}\n`);
    return 0;
  }
  io.stderr.write(`invalid: ${errors} error${errors === 1 ? '' : 's'}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}\n`);
  return 1;
};
