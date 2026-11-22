import { parseArgs } from 'node:util';
import { type DescribeEntry, createGrader } from '../../grader.ts';
import { resolveUserPath } from '../../core/paths.ts';
import { type Command, USAGE, positionalArgs } from '../common.ts';

const HEADINGS = { step: 'Steps', check: 'Checks', builder: 'Builders', reporter: 'Reporters', scorer: 'Scorers' } as const;

/** `a, b?` for an object schema: required keys plain, optional ones with `?`; other shapes have no summary. */
function paramSummary(schema: object): string {
  const { properties, required } = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (properties === undefined) return '';
  return Object.keys(properties)
    .map((key) => (required?.includes(key) ? key : `${key}?`))
    .join(', ');
}

function renderText(entries: DescribeEntry[]): string {
  const lines: string[] = [];
  for (const [kind, heading] of Object.entries(HEADINGS)) {
    const group = entries.filter((e) => e.kind === kind);
    if (group.length === 0) continue;
    lines.push(`${heading}:`);
    for (const e of group) {
      lines.push(`  ${e.name}`, `    ${e.description}`);
      const params = paramSummary(e.params);
      if (params !== '') lines.push(`    params: ${params}`);
      if (e.example !== undefined) lines.push('    example:', ...e.example.split('\n').map((l) => `      ${l}`));
    }
    lines.push('');
  }
  lines.push('Use --json for the full parameter schemas.');
  return `${lines.join('\n')}\n`;
}

export const describeCommand: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [dir] = positionalArgs('describe', positionals, 0, 1);
  const entries = await createGrader(dir === undefined ? {} : { assignmentDir: resolveUserPath(dir, io.cwd ?? process.cwd()) }).describe();
  io.stdout.write(values.json ? `${JSON.stringify(entries, null, 2)}\n` : renderText(entries));
  return 0;
};
