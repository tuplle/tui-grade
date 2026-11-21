import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILD_CODES } from '../../core/build.ts';
import type { CheckResult, ScenarioResult, SubmissionResult, Translate } from '../../core/contracts.ts';
import { localize } from '../../core/i18n.ts';
import { stripControl } from '../../core/text.ts';
import { fp } from '../../core/plugin.ts';
import { writeFileAtomic } from '../../core/workspace.ts';
import { formatNumber, publicResult } from '../reporter-shared.ts';

const LOG_MAX_LINES = 60;
const LOG_MAX_CHARS = 6000;

/** Escapes markdown syntax in a single line of text (names, titles and messages may come from students). */
const inline = (text: string): string =>
  stripControl(text.replace(/\s*\r?\n\s*/g, ' ')).replace(/[\\`*_[\]<>|]/g, '\\$&');

/** A code fence that cannot be closed by the content (one backtick longer than the longest run inside). */
function fence(text: string, indent = ''): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return [`${indent}${mark}`, ...text.replace(/\r?\n$/, '').split(/\r?\n/).map((line) => `${indent}${line}`), `${indent}${mark}`];
}

const isBuildCode = (message: string): boolean => (Object.values(BUILD_CODES) as string[]).includes(message);
const buildMessage = (message: string, t: Translate): string => (isBuildCode(message) ? t(`build.${message}`) : message);

/** The tail of the build log: the errors are at the end. Returns the number of lines shown when something was cut. */
function excerpt(log: string): { text: string; cutTo?: number } {
  const lines = log.replace(/\r?\n$/, '').split(/\r?\n/);
  let kept = lines.slice(-LOG_MAX_LINES);
  let text = kept.join('\n');
  if (text.length > LOG_MAX_CHARS) {
    text = text.slice(-LOG_MAX_CHARS);
    kept = text.split('\n');
  }
  return kept.length < lines.length || text.length < log.length - 1 ? { text, cutTo: kept.length } : { text };
}

function checkLines(check: CheckResult, t: Translate): string[] {
  const verdict = t(check.pass ? 'report.check.passed' : 'report.check.failed');
  const lines = [`- ${check.pass ? '✔' : '✘'} ${inline(check.description)}: ${verdict}`];
  if (check.pass || check.hidden) return lines;
  if (check.expected === undefined && check.actual === undefined) {
    if (check.message !== undefined) lines.push(`  ${inline(check.message)}`);
    return lines;
  }
  for (const [label, value] of [
    [t('report.expected'), check.expected],
    [t('report.actual'), check.actual],
  ] as const) {
    if (value === undefined) continue;
    lines.push('', `  **${label}:**`, '', ...fence(value, '  '));
  }
  return lines;
}

function scenarioLines(s: ScenarioResult, points: string | undefined, locale: string, t: Translate): string[] {
  const status = t(`report.scenario.${s.status}`);
  const lines = ['', `### ${inline(s.id)}: ${inline(localize(s.title, locale))} — ${status}${points === undefined ? '' : ` (${points})`}`];
  if (s.error !== undefined) lines.push('', ...s.error.split(/\r?\n/).map((line) => `> ${inline(line)}`));
  if (s.checks.length > 0) {
    lines.push('', `**${t('report.checks')}:**`, '');
    for (const check of s.checks) lines.push(...checkLines(check, t));
  }
  return lines;
}

const pair = (points: number, max: number): string => `${formatNumber(points)} / ${formatNumber(max)}`;

export function renderMarkdown(source: SubmissionResult, locale: string, t: Translate): string {
  const result = publicResult(source, t);
  const { student, build, score } = result;
  const lines = [`# ${inline(t('report.title', { assignment: result.assignment }))}`, ''];

  const name = student.displayName === student.id || student.displayName === '' ? student.id : `${student.displayName} (${student.id})`;
  lines.push(`- **${t('report.student')}:** ${inline(name)}`);
  lines.push(`- **${t('report.points')}:** ${pair(score.points, score.max)}`);
  const buildState = t(build.ok ? 'report.build.ok' : 'report.build.failed');
  lines.push(`- **${t('report.build')}:** ${buildState}${!build.ok && build.message !== undefined ? ` — ${inline(buildMessage(build.message, t))}` : ''}`);

  if (!build.ok && build.log !== '') {
    const { text, cutTo } = excerpt(build.log);
    lines.push('', `## ${t('report.build.log')}`, '');
    if (cutTo !== undefined) lines.push(t('report.build.log.truncated', { lines: cutTo }), '');
    lines.push(...fence(text));
  }

  const scenarioPoints = new Map<string, string>();
  for (const group of score.groups) for (const s of group.scenarios) if (s.max > 0) scenarioPoints.set(s.id, pair(s.points, s.max));
  for (const s of score.ungrouped) if (s.max > 0) scenarioPoints.set(s.id, pair(s.points, s.max));

  if (score.groups.length > 0) {
    lines.push('', `| ${t('report.group')} | ${t('report.points')} |`, '| --- | --- |');
    for (const g of score.groups) {
      const value = g.pending ? `${t('report.manual.pending')} (— / ${formatNumber(g.max)})` : pair(g.points, g.max);
      lines.push(`| ${inline(localize(g.title, locale))} | ${value} |`);
    }
  } else if (score.ungrouped.length > 0) {
    const titles = new Map(result.scenarios.map((s) => [s.id, localize(s.title, locale)]));
    lines.push('', `| ${t('report.scenario')} | ${t('report.points')} |`, '| --- | --- |');
    for (const s of score.ungrouped) lines.push(`| ${inline(titles.get(s.id) ?? s.id)} | ${pair(s.points, s.max)} |`);
  }

  if (result.scenarios.length > 0) {
    lines.push('', `## ${t('report.scenarios')}`);
    for (const s of result.scenarios) lines.push(...scenarioLines(s, scenarioPoints.get(s.id), locale, t));
  }

  const warnings = [...result.warnings];
  if (score.groups.length > 0 && score.ungrouped.length > 0) {
    warnings.push(t('report.warning.ungrouped', { ids: score.ungrouped.map((s) => s.id).join(', ') }));
  }
  if (warnings.length > 0) {
    lines.push('', `## ${t('report.warnings')}`, '', ...warnings.map((w) => `- ${inline(w)}`));
  }

  lines.push('', `_${inline(t('report.generated', { date: result.startedAt }))}_`, '');
  return lines.join('\n');
}

export async function writeReport(dir: string, result: SubmissionResult, locale: string, t: Translate): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, 'report.md'), renderMarkdown(result, locale, t));
}

export const reporterMarkdown = fp(
  (app) => {
    app.reporter('markdown', {
      description: 'Writes a localized human-readable report of each submission to <out>/<student>/report.md.',
      scope: 'submission',
      async reportSubmission(ctx, result) {
        await writeReport(join(ctx.outDir, result.student.id), result, ctx.locale, ctx.t);
      },
    });
  },
  { name: 'reporter-markdown' },
);
