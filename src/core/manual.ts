import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Loads manually awarded points: `{ "<studentId>": { "<groupId>": number } }` as YAML or JSON
 * (JSON is valid YAML). An empty file means no manual points. Throws a descriptive Error on a
 * missing/unparseable file, a wrong shape, or a non-numeric value.
 */
export async function loadManualPoints(file: string): Promise<Record<string, Record<string, number>>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read manual points file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`cannot parse manual points file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (data === null || data === undefined) return {};
  if (!isRecord(data)) {
    throw new Error(`manual points file ${file} must be a mapping of student id → { group id: number }`);
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [student, groups] of Object.entries(data)) {
    if (!isRecord(groups)) {
      throw new Error(`manual points file ${file}: entry '${student}' must be a mapping of group id → number`);
    }
    const points: Record<string, number> = {};
    for (const [group, value] of Object.entries(groups)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`manual points file ${file}: '${student}.${group}' must be a number (got ${JSON.stringify(value)})`);
      }
      points[group] = value;
    }
    result[student] = points;
  }
  return result;
}
