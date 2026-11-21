import * as api from '../src/index.ts';

describe('public API', () => {
  it.each([
    'App',
    'ConfigError',
    'PathEscapeError',
    'VERSION',
    'createGrader',
    'defineBuilder',
    'defineCheck',
    'definePlugin',
    'defineReporter',
    'defineScorer',
    'defineStep',
    'fp',
    'gradeAll',
    'minimalEnv',
    'normalizeText',
    'publicResult',
    'runProcess',
    'safeJoin',
    'z',
  ])('exports %s', (name) => {
    expect(Object.keys(api)).toContain(name);
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });

  it('the define* helpers return their argument unchanged', () => {
    const step = { description: 'd', params: api.z.unknown(), run: async (): Promise<void> => {} };
    expect(api.defineStep(step)).toBe(step);
    const check = { description: 'd', params: api.z.unknown(), source: 'none' as const, describe: () => 'x', run: async () => ({ pass: true }) };
    expect(api.defineCheck(check)).toBe(check);
    const builder = { description: 'd', params: api.z.unknown(), build: async () => { throw new Error('unused'); } };
    expect(api.defineBuilder(builder)).toBe(builder);
    const reporter = { description: 'd', scope: 'run' as const };
    expect(api.defineReporter(reporter)).toBe(reporter);
    const scorer = { description: 'd', params: api.z.unknown(), score: () => { throw new Error('unused'); } };
    expect(api.defineScorer(scorer as never)).toBe(scorer);
  });

  it('safeJoin, normalizeText, minimalEnv and PathEscapeError work as exported', () => {
    expect(() => api.safeJoin('/tmp/x', '../y')).toThrow(api.PathEscapeError);
    expect(api.normalizeText('a\r\n\u001b[31mb\u001b[0m')).toBe('a\nb');
    expect(api.minimalEnv('/w', { A: '1' })).toMatchObject({ HOME: '/w', A: '1', LANG: 'C.UTF-8' });
  });
});
