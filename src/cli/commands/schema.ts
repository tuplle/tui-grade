import { parseArgs } from 'node:util';
import { createGrader } from '../../grader.ts';
import { resolveUserPath } from '../../core/paths.ts';
import { type Command, USAGE, positionalArgs } from '../common.ts';

export const schemaCommand: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [dir] = positionalArgs('schema', positionals, 0, 1);
  const schema = await createGrader(dir === undefined ? {} : { assignmentDir: resolveUserPath(dir, io.cwd ?? process.cwd()) }).schema();
  io.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
  return 0;
};
