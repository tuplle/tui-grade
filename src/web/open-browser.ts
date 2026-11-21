import { spawn } from 'node:child_process';

/** The platform command that opens a URL in the default browser. */
export function browserCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  url: string,
): [string, string[]] {
  if (platform === 'win32') return [env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Best effort: the printed URL remains the fallback when no opener is available. */
export function openBrowser(url: string): void {
  const [command, args] = browserCommand(process.platform, process.env, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore: the URL is printed
  }
}
