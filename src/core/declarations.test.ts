import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { applyDeclarations, formatDeclarations, parseDeclarations } from './declarations';
import { sliceSweeps } from './variables';

describe('text variable declarations', () => {
  it('defaults bare unknowns and parameters to zero', () => {
    expect(parseDeclarations('unknown y\nunknown z;', 'unknown')).toEqual({ variables: [
      { name: 'y', kind: 'unknown', value: 0 }, { name: 'z', kind: 'unknown', value: 0 },
    ], swept: [] });
    expect(parseDeclarations('parameter a', 'parameter').variables).toEqual([{ name: 'a', kind: 'parameter', value: 0 }]);
  });

  it('reads value, step, minimum, maximum in that order and supports mathematical numeric expressions', () => {
    expect(parseDeclarations('parameter Vdd (2 + 3), 1, 0, 10 sweep # centered\nparameter C 10n;', 'parameter')).toEqual({
      variables: [
        { name: 'Vdd', kind: 'parameter', value: 5, step: 1, min: 0, max: 10 },
        { name: 'C', kind: 'parameter', value: 1e-8 },
      ], swept: ['Vdd'],
    });
  });

  it('allows incomplete slider metadata without filling in bounds', () => {
    expect(parseDeclarations('parameter a 2 .5\nparameter b 3 1 0', 'parameter').variables).toEqual([
      { name: 'a', kind: 'parameter', value: 2, step: .5 },
      { name: 'b', kind: 'parameter', value: 3, step: 1, min: 0 },
    ]);
  });

  it('rejects malformed syntax, duplicate or reserved names and unsafe numeric expressions', () => {
    for (const source of ['unknown', 'unknown pi', 'unknown y\nunknown y 3', 'unknown y x', 'unknown y alert(1)', 'unknown y 0 1', 'unknown y sweep']) {
      expect(() => parseDeclarations(source, 'unknown')).toThrow(/Declaration/);
    }
    expect(() => parseDeclarations('parameter a (1 + 2', 'parameter')).toThrow(/parenthesized/);
    expect(() => parseDeclarations('parameter a 1)', 'parameter')).toThrow(/parenthesis/);
    expect(() => parseDeclarations('a 2', 'parameter')).toThrow(/Start this declaration/);
  });

  it('requires complete, increasing slider settings before sweep', () => {
    for (const source of ['parameter a sweep', 'parameter a 5 1 0 sweep', 'parameter a 5 0 0 10 sweep', 'parameter a 5 1 10 0 sweep', 'parameter a 11 1 0 10 sweep']) {
      expect(() => parseDeclarations(source, 'parameter')).toThrow();
    }
  });

  it('replaces one tab atomically while preserving declarations in the other tab', () => {
    const config = clone(starter), old = clone(config);
    expect(() => applyDeclarations(config, 'parameter', parseDeclarations('parameter y', 'parameter'))).toThrow(/another declaration/);
    expect(config).toEqual(old);
    applyDeclarations(config, 'unknown', parseDeclarations('unknown y 4\nunknown z', 'unknown'));
    expect(config.variables.filter(variable => variable.kind === 'unknown')).toEqual([
      { name: 'y', kind: 'unknown', value: 4 }, { name: 'z', kind: 'unknown', value: 0 },
    ]);
    expect(config.variables.filter(variable => variable.kind === 'parameter')).toEqual(old.variables.filter(variable => variable.kind === 'parameter'));
    expect(config.sweep).toEqual(old.sweep);
  });

  it('retains the marked main selection while adding and removing multiple slice dimensions', () => {
    const config = clone(starter), axes = clone(config.axes);
    const parsed = parseDeclarations('parameter a 1 1 0 5 sweep\nparameter x 0 .5 -5 5 sweep\nparameter b 2 1 0 4 sweep', 'parameter');
    applyDeclarations(config, 'parameter', parsed);
    expect(config.sweep).toMatchObject({ parameter: 'x', step: .5, min: -5, max: 5, points: 21, startAt: 0 });
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['a', 'b']);
    expect(config.axes).toEqual(axes);
    const saved = clone(config);
    applyDeclarations(config, 'parameter', parsed);
    expect(config).toEqual(saved);
    applyDeclarations(config, 'parameter', parseDeclarations('parameter a 1 1 0 5 sweep\nparameter b 2', 'parameter'));
    expect(config.sweep.parameter).toBe('a');
    expect(sliceSweeps(config)).toEqual([]);
  });

  it('clears the main selection when no parameter has the sweep keyword', () => {
    const config = clone(starter);
    applyDeclarations(config, 'parameter', parseDeclarations('parameter x', 'parameter'));
    expect(config.sweep.parameter).toBe('');
    expect(config.sweep.step).toBeUndefined();
    expect(sliceSweeps(config)).toEqual([]);
    expect(config.variables.find(variable => variable.name === 'x')).toEqual({ name: 'x', kind: 'parameter', value: 0 });
  });

  it('preserves the imposed and released variables in constrained mode', () => {
    const config = clone(starter);
    Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'a' });
    applyDeclarations(config, 'parameter', parseDeclarations('parameter a 1\nparameter x 0 1 -5 5 sweep', 'parameter'));
    expect(config.sweep).toMatchObject({ parameter: 'y', release: 'a' });
    expect(sliceSweeps(config).map(dimension => dimension.parameter)).toEqual(['x']);
    const old = clone(config);
    expect(() => applyDeclarations(config, 'parameter', parseDeclarations('parameter a 1 1 0 5 sweep', 'parameter'))).toThrow(/released/);
    expect(config).toEqual(old);
  });

  it('checks sample limits before replacing the accepted configuration', () => {
    const config = clone(starter), old = clone(config);
    expect(() => applyDeclarations(config, 'parameter', parseDeclarations('parameter x 0 1 0 50000 sweep', 'parameter'))).toThrow(/50,000/);
    expect(config).toEqual(old);
    expect(() => applyDeclarations(config, 'parameter', parseDeclarations('parameter x 0 1 0 1 sweep\nparameter a 0 1 0 10000 sweep', 'parameter'))).toThrow(/10,000/);
    expect(config).toEqual(old);
    expect(() => applyDeclarations(config, 'parameter', parseDeclarations('parameter x 1e20 1 0 2e20 sweep', 'parameter'))).toThrow(/distinct samples/);
    expect(config).toEqual(old);
  });

  it('formats the accepted data with complete swept settings and round trips', () => {
    const config = clone(starter);
    const source = formatDeclarations(config, 'parameter');
    expect(source).toContain('parameter x 0 0.1 -5 5 sweep');
    expect(formatDeclarations(config, 'unknown')).toBe('unknown y 1');
    const before = clone(config.variables);
    applyDeclarations(config, 'parameter', parseDeclarations(source, 'parameter'));
    expect(config.variables).toEqual(before);
  });

  it('does not invent slider options while formatting partial definitions', () => {
    const config = clone(starter);
    config.variables = [
      { name: 'a', kind: 'parameter', value: 0 },
      { name: 'b', kind: 'parameter', value: 1, step: .1 },
      { name: 'c', kind: 'parameter', value: 2, min: 0, max: 4 },
    ];
    config.sweep.parameter = '';
    expect(formatDeclarations(config, 'parameter')).toBe('parameter a\nparameter b 1 0.1\nparameter c 2');
  });
});
