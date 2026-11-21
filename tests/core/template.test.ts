import { findVariables, interpolate, UnknownVariableError } from '../../src/core/template.ts';

describe('findVariables', () => {
  it('finds all variable names in nested values', () => {
    const value = { run: { args: ['${binary}', '--dir', '${workdir}/x'] }, n: 3, ok: true, none: null };
    expect(findVariables(value)).toEqual(['binary', 'workdir']);
  });

  it('deduplicates names and ignores non-placeholders', () => {
    expect(findVariables(['${a} ${a}', '$a', '${1x}', '${ b }'])).toEqual(['a']);
  });
});

describe('interpolate', () => {
  it('replaces variables deeply without touching other values', () => {
    const input = { args: ['${type}', 'x-${type}'], n: 1, flag: false, nested: { s: '${type}!' } };
    expect(interpolate(input, { type: 'a' })).toEqual({
      args: ['a', 'x-a'],
      n: 1,
      flag: false,
      nested: { s: 'a!' },
    });
    expect(input.args[0]).toBe('${type}'); // input is not mutated
  });

  it('throws UnknownVariableError for an unknown variable by default', () => {
    expect(() => interpolate('${missing}', { type: 'a' })).toThrow(UnknownVariableError);
    expect(() => interpolate('${missing}', {})).toThrow('unknown variable ${missing}');
  });

  it('keeps unknown variables verbatim with keepUnknown', () => {
    expect(interpolate(['${binary} ${type}'], { type: 'a' }, { keepUnknown: true })).toEqual(['${binary} a']);
  });

  it('does not treat inherited properties as variables', () => {
    expect(() => interpolate('${toString}', {})).toThrow(UnknownVariableError);
  });
});
