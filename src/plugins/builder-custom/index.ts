import { z } from 'zod';
import { execBuildCommand } from '../../core/build.ts';
import { fp } from '../../core/plugin.ts';

const params = z.strictObject({
  command: z.string().min(1),
  shell: z.enum(['auto', 'sh', 'cmd', 'powershell']).optional(),
});

type Shell = z.output<typeof params>['shell'];

function commandFor(shell: Shell): { command: string; args: string[] } {
  const effective = shell ?? 'auto';
  if (effective === 'cmd' || (effective === 'auto' && process.platform === 'win32')) {
    return { command: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  if (effective === 'powershell') return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command'] };
  return { command: 'sh', args: ['-c'] };
}

export const builderCustom = fp(
  (app) => {
    app.builder('custom', {
      description:
        'Runs a shell command in the project root (sh -c, cmd /c on Windows, or an explicit shell); set `binary` in the assignment for the result.',
      params,
      build: (ctx, p: z.output<typeof params>) => {
        const shell = commandFor(p.shell);
        return execBuildCommand(ctx, shell.command, [...shell.args, p.command]);
      },
    });
  },
  { name: 'builder-custom' },
);
