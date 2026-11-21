import { z } from 'zod';
import type { CheckContext, CheckDef, CheckOutcome, Issue } from '../../core/contracts.ts';
import { fp } from '../../core/plugin.ts';
import { safeJoin } from '../../core/workspace.ts';
import { readGuardedText } from '../shared.ts';

// Static checks over the student's sources. The files live in the student's project (`ctx.projectDir`),
// not in the scenario workdir; they are read with the same guard as the workdir file checks (regular
// file, symlinks not followed, size capped at `limits.outputLimitBytes`).

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Reads a project file as normalized text; a failure outcome when it cannot be read (never throws). */
async function readProjectFile(ctx: CheckContext, rel: string): Promise<{ text: string } | { failure: CheckOutcome }> {
  if (ctx.projectDir === undefined) return { failure: { pass: false, message: 'the submission has no project directory' } };
  let path: string;
  try {
    path = safeJoin(ctx.projectDir, ctx.interpolate(rel));
  } catch (e) {
    return { failure: { pass: false, message: messageOf(e) } };
  }
  return readGuardedText(path, rel, ctx.limits.outputLimitBytes);
}

// ---- ranges -------------------------------------------------------------------------------

const count = z.number().int().nonnegative();
const rangeParams = z
  .strictObject({ file: z.string().min(1), min: count.optional(), max: count.optional() })
  .refine((p) => p.min !== undefined || p.max !== undefined, { message: 'at least one of min and max is required' });
type RangeParams = z.output<typeof rangeParams>;

function rangeText(p: RangeParams): string {
  if (p.min !== undefined && p.max !== undefined) return `${p.min}..${p.max}`;
  return p.min !== undefined ? `>= ${p.min}` : `<= ${p.max}`;
}

const inRange = (n: number, p: RangeParams): boolean => (p.min === undefined || n >= p.min) && (p.max === undefined || n <= p.max);

function validateRange(p: RangeParams): Issue[] {
  if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
    return [{ path: '/min', message: `min (${p.min}) is greater than max (${p.max})`, severity: 'error' }];
  }
  return [];
}

// ---- C/C++ scanning -----------------------------------------------------------------------

/**
 * Blanks out everything that is not code: comments become a space, string and character literals
 * become `""` / `''`, and preprocessor directives (a `#` that starts a line, including continuation
 * lines and comments inside the directive) are dropped. Newlines are kept. Literals end at an
 * unescaped newline, so an unbalanced quote cannot swallow the rest of the file.
 */
export function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  let lineStart = true;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' && i + 1 < n ? 2 : 1;
      if (src[i] === c) i++;
      out += c + c;
      lineStart = false;
    } else if (c === '#' && lineStart) {
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) i += 2; // an escaped newline continues the directive
        else if (src[i] === '/' && src[i + 1] === '*') {
          const end = src.indexOf('*/', i + 2);
          i = end === -1 ? n : end + 2;
        } else if (src[i] === '/' && src[i + 1] === '/') {
          while (i < n && src[i] !== '\n') i++;
        } else i++;
      }
    } else {
      out += c;
      i++;
      if (c === '\n') lineStart = true;
      else if (c !== ' ' && c !== '\t' && c !== '\r') lineStart = false;
    }
  }
  return out;
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'else', 'do', 'catch', 'return', 'sizeof']);

/** Removes `__attribute__((...))`, `__declspec(...)` and `alignas(...)` with their balanced parentheses. */
function dropAttributes(head: string): string {
  let out = head;
  for (;;) {
    const m = /\b(?:__attribute__|__declspec|alignas|_Alignas)\s*\(/.exec(out);
    if (m === null) return out;
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < out.length && depth > 0) {
      if (out[j] === '(') depth++;
      else if (out[j] === ')') depth--;
      j++;
    }
    out = `${out.slice(0, m.index)} ${out.slice(j)}`;
  }
}

/** Whether the text before a `{` looks like a function signature (and not a control statement or initializer). */
function isFunctionHead(raw: string): boolean {
  const head = dropAttributes(raw).replace(/\s+/g, ' ').trim();
  const open = head.indexOf('(');
  if (open === -1) return false; // struct/enum/union/class bodies, `do`, `else`, plain initializers
  if (!/\)\s*(?:(?:const|volatile|noexcept|override|final|mutable|&&|&)\s*)*$|\)\s*->\s*[\w:<>*&\s]+$/.test(head)) return false;
  const first = /^[A-Za-z_]\w*/.exec(head)?.[0];
  if (first !== undefined && CONTROL.has(first)) return false;
  const before = head.slice(0, open).trimEnd();
  const name = /[A-Za-z_~]\w*$/.exec(before)?.[0];
  if (name === undefined || CONTROL.has(name)) return false;
  // An `=` outside parentheses is an initializer (`int (*fp)(int) = ...`), except in `operator==` and friends.
  let depth = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '=' && depth === 0 && !/\boperator\s*[^\s\w(]*$/.test(head.slice(0, i + 1))) return false;
  }
  return true;
}

const isNamespaceHead = (head: string): boolean => /^(?:inline\s+)?namespace\b[^()=]*$/.test(dropAttributes(head).trim().replace(/\s+/g, ' '));
const isExternBlockHead = (head: string): boolean => /^extern\s*""$/.test(head.trim().replace(/\s+/g, ' '));

/**
 * Counts function definitions in C/C++ source with a heuristic: a signature followed by `{`, seen at
 * brace depth 0 or inside `namespace` / `extern "C"` blocks. Bodies of functions, class/struct/union/enum
 * definitions and initializers are skipped (so C++ member functions defined inside a class are not
 * counted). Prototypes, calls, function-like macros and anything in comments/strings are not counted.
 */
export function countFunctions(src: string): number {
  const text = stripNonCode(src);
  let functions = 0;
  let head = '';
  let transparent = 0; // open namespace / extern "C" blocks
  let opaque = 0; // brace depth inside a function body, class, enum, initializer, ...
  for (const c of text) {
    if (opaque > 0) {
      if (c === '{') opaque++;
      else if (c === '}') {
        opaque--;
        if (opaque === 0) head = '';
      }
    } else if (c === '{') {
      if (isNamespaceHead(head) || isExternBlockHead(head)) {
        transparent++;
        head = '';
      } else {
        if (isFunctionHead(head)) functions++;
        opaque = 1;
        head = '';
      }
    } else if (c === '}') {
      if (transparent > 0) transparent--;
      head = '';
    } else if (c === ';') {
      head = '';
    } else {
      head += c;
    }
  }
  return functions;
}

// ---- checks -------------------------------------------------------------------------------

const functionCount: CheckDef<RangeParams> = {
  description:
    'Passes when the number of function definitions in a C/C++ source file of the project is within min/max (heuristic: ' +
    "a signature followed by '{' at brace depth 0 or inside namespace / extern \"C\" blocks; 'main' counts; prototypes, calls, " +
    'macros and class bodies do not).',
  example: '- function_count: { file: main.c, min: 5 }\n- function_count: { file: src/util.c, min: 2, max: 10 }',
  params: rangeParams,
  source: 'none',
  validate: validateRange,
  describe: (p, t) => t('check.function_count', { file: p.file, range: rangeText(p) }),
  async run(ctx, p): Promise<CheckOutcome> {
    const content = await readProjectFile(ctx, p.file);
    if ('failure' in content) return content.failure;
    const n = countFunctions(content.text);
    if (inRange(n, p)) return { pass: true };
    return { pass: false, message: `'${p.file}' defines ${n} function${n === 1 ? '' : 's'}`, expected: rangeText(p), actual: String(n) };
  },
};

const noCompilerWarnings: CheckDef<true> = {
  description: 'Passes when the build succeeded without any compiler warnings.',
  example: '- no_compiler_warnings: true',
  params: z.literal(true),
  source: 'none',
  describe: (_p, t) => t('check.no_compiler_warnings'),
  async run(ctx): Promise<CheckOutcome> {
    const { build } = ctx;
    if (build === undefined) return { pass: false, message: 'no build result is available' };
    if (!build.ok) return { pass: false, message: 'the build failed', expected: '0', actual: `${build.warnings}` };
    if (build.warnings === 0) return { pass: true };
    const w = build.warnings;
    return { pass: false, message: `the build produced ${w} compiler warning${w === 1 ? '' : 's'}`, expected: '0', actual: String(w) };
  },
};

/** Lines are `\n`-separated (CRLF files are normalized first); a trailing newline does not add a line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

const fileLineCount: CheckDef<RangeParams> = {
  description: 'Passes when the number of lines of a source file of the project is within min/max (a trailing newline does not add a line).',
  example: '- file_line_count: { file: main.c, max: 300 }',
  params: rangeParams,
  source: 'none',
  validate: validateRange,
  describe: (p, t) => t('check.file_line_count', { file: p.file, range: rangeText(p) }),
  async run(ctx, p): Promise<CheckOutcome> {
    const content = await readProjectFile(ctx, p.file);
    if ('failure' in content) return content.failure;
    const n = countLines(content.text);
    if (inRange(n, p)) return { pass: true };
    return { pass: false, message: `'${p.file}' has ${n} line${n === 1 ? '' : 's'}`, expected: rangeText(p), actual: String(n) };
  },
};

export const checksSource = fp(
  (app) => {
    app.check('function_count', functionCount);
    app.check('no_compiler_warnings', noCompilerWarnings);
    app.check('file_line_count', fileLineCount);
  },
  { name: 'checks-source' },
);
