import { browserCommand } from '../../src/web/open-browser.ts';

describe('browserCommand', () => {
  it('uses xdg-open on Linux', () => {
    expect(browserCommand('linux', {}, 'http://127.0.0.1:3333/')).toEqual(['xdg-open', ['http://127.0.0.1:3333/']]);
  });

  it('uses open on macOS', () => {
    expect(browserCommand('darwin', {}, 'http://127.0.0.1:3333/')).toEqual(['open', ['http://127.0.0.1:3333/']]);
  });

  it('uses the Windows command shell and start', () => {
    const [command, args] = browserCommand('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'http://127.0.0.1:3333/');
    expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', 'start', '', 'http://127.0.0.1:3333/']);
  });
});
