import { VERSION } from '../src/index.ts';

describe('smoke', () => {
  it('exports the package version', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
