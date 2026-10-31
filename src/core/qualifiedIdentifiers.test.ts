import { describe, expect, it } from 'vitest';
import { compile, residual } from './expression';
import { compileComplex } from './complexExpression';
import { equationAssignment } from './equations';
import { assignmentPlan, evaluateAssignments, substitutionPlan } from './assignments';
import { applyDeclarations, formatDeclarations, parseDeclarations } from './declarations';
import { applyValidityBounds } from './constraints';
import { prepare, solve } from './solver';
import { clone, starter } from '../examples';
import type { Configuration, Scope, Variable } from './types';

describe('qualified scalar identifiers', () => {
  it('keeps instance members atomic and distinct from similar global names', () => {
    const expression = compile('M1.id + M2.id*2 + M1_id + 2.2k + .5 + 1e-3');
    expect(expression.variables).toEqual(['M1.id', 'M2.id', 'M1_id']);
    expect(expression.evaluate({ 'M1.id': 3, 'M2.id': 4, M1_id: 5 })).toBeCloseTo(2216.501, 10);
    expect(compile('M1.pi + pi').evaluate({ 'M1.pi': 2 })).toBe(2 + Math.PI);
  });

  it('reads only an own scalar key, without looking through objects or prototypes', () => {
    let accessed = false;
    const nested = Object.defineProperty({}, 'M1', { get() { accessed = true; return { id: 3 }; } });
    expect(() => compile('M1.id').evaluate(nested as Scope)).toThrow('No value defined');
    expect(accessed).toBe(false);
    expect(() => compile('M1.id').evaluate(Object.create({ 'M1.id': 3 }))).toThrow('No value defined');
    const values: Scope = Object.assign(Object.create(null), { 'M1.__proto__': 4, 'M1.constructor': 5 });
    expect(compile('M1.__proto__ + M1.constructor').evaluate(values)).toBe(9);
  });

  it('rejects nested members, indexing, qualified calls, and JavaScript syntax', () => {
    for (const source of [
      'M1.id.real', 'M1.id[0]', 'M1["id"]', 'M1.id()', 'M1.sin(0)',
      'M1 . id', 'M1..id', '.M1', 'M1?.id', 'M1.id = 2',
      'M1.id; alert(1)', 'M1.id.constructor(1)', 'window.alert(1)',
    ]) expect(() => compile(source), source).toThrow();
  });

  it('uses the same atomic names for complex values and real projections', () => {
    const expression = compileComplex('M1.z + M2.z*i + M1.i');
    expect(expression.variables).toEqual(['M1.z', 'M2.z', 'i', 'M1.i']);
    expect(expression.evaluate({ 'M1.z': { re: 1, im: 2 }, 'M2.z': 3, 'M1.i': 4 })).toEqual({ re: 5, im: 5 });
    expect(compileComplex('abs(M1.z)').evaluate({ 'M1.z': { re: 3, im: 4 } })).toBe(5);
  });

  it('recognizes qualified assignment targets without accepting general expressions', () => {
    expect(equationAssignment(' M1.id = M1.g * gain ')).toEqual({ name: 'M1.id', source: 'M1.g * gain' });
    expect(residual('M1.id = M1.g * gain').evaluate({ 'M1.id': 6, 'M1.g': 2, gain: 3 })).toBe(0);
    for (const source of ['M1.id + 1 = 3', 'M1.id.real = 2', 'M1.id == 2', 'M1.id = 2 = 3']) {
      expect(equationAssignment(source), source).toBeNull();
    }
  });

  it('orders direct assignments across instances without joining their namespaces', () => {
    const plan = assignmentPlan(
      ['M1.out = M1.gain*M1.input', 'M2.out = M2.gain*M2.input', 'M1.input = p', 'M2.input = p + 1'],
      ['M1.out', 'M2.out', 'M1.input', 'M2.input'], [], { p: 2, 'M1.gain': 3, 'M2.gain': 5 },
    );
    expect(plan).not.toBeNull();
    expect(evaluateAssignments(plan!, { p: 2, 'M1.gain': 3, 'M2.gain': 5 })).toMatchObject({
      'M1.out': 6, 'M2.out': 15, 'M1.input': 2, 'M2.input': 3,
    });
  });

  it('eliminates qualified assignments and preserves bounded numerical variables', () => {
    const plan = substitutionPlan(
      ['M1.aux = M1.id + p', 'M1.id^2 = M1.aux'], ['M1.aux', 'M1.id'], [], { p: 2 }, new Set(['M1.id']),
    );
    expect([...plan.names]).toEqual(['M1.aux']);
    expect(plan.equations).toEqual(['M1.id^2 = M1.aux']);
    expect(plan.ordered.map(assignment => assignment.name)).toEqual(['M1.aux']);
    expect(plan.ordered[0].expression.evaluate({ 'M1.id': 3, p: 2 })).toBe(5);
    expect(plan.circular).toBe(false);
  });

  it('parses, applies, and formats qualified parameter sweeps and unknown guesses', () => {
    const parsed = parseDeclarations('parameter M1.VTH (.5 + .2) .1 0 1 sweep\nparameter M2.K 2m', 'parameter');
    expect(parsed).toEqual({ variables: [
      { name: 'M1.VTH', kind: 'parameter', value: .7, step: .1, min: 0, max: 1 },
      { name: 'M2.K', kind: 'parameter', value: .002 },
    ], swept: ['M1.VTH'] });
    expect(parseDeclarations('unknown M1.id 500u', 'unknown').variables).toEqual([{ name: 'M1.id', kind: 'unknown', value: .0005 }]);
    const config = clone(starter);
    applyDeclarations(config, 'parameter', parsed);
    expect(config.sweep.parameter).toBe('M1.VTH');
    expect(parseDeclarations(formatDeclarations(config, 'parameter'), 'parameter')).toEqual(parsed);
    for (const name of ['M1.a.b', 'M1.', '.g', 'M1[0]', 'M1.2']) {
      expect(() => parseDeclarations(`parameter ${name} 1`, 'parameter'), name).toThrow();
    }
  });

  it('infers inclusive bounds using qualified unknown and fixed names on either side', () => {
    const variables: Variable[] = [{ name: 'M1.id', kind: 'unknown', value: 1 }, { name: 'M2.id', kind: 'unknown', value: 2 }];
    applyValidityBounds(variables, 'M1.id >= 0\nbounds.upper >= M1.id\n-2 <= M2.id\nM2.id <= bounds.upper*2', { 'bounds.upper': 3 });
    expect(variables).toEqual([
      { name: 'M1.id', kind: 'unknown', value: 1, min: 0, max: 3 },
      { name: 'M2.id', kind: 'unknown', value: 2, min: -2, max: 6 },
    ]);
  });

  it('retains direct real and complex solver paths for qualified names', () => {
    const config: Configuration = clone(starter);
    config.variables = [
      { name: 'p', kind: 'parameter', value: 2 }, { name: 'M1.gain', kind: 'parameter', value: 3 },
      { name: 'M1.out', kind: 'unknown', value: 0 },
    ];
    config.equations = 'M1.out = M1.gain*p;';
    config.axes = { x: 'p', y: 'M1.out' }; config.sweep.parameter = 'p';
    const real = prepare(config, 2);
    expect(real.direct).toBeDefined();
    expect(solve(real, [1000], config.solver).values['M1.out']).toBe(6);
    config.solver.complex = true;
    config.equations = 'M1.out = M1.gain*p*(1+i);'; config.axes.y = 'abs(M1.out)';
    const complex = prepare(config, 2);
    expect(complex.direct).toBeDefined();
    expect(solve(complex, [1000, -1000], config.solver).complexValues?.['M1.out']).toEqual({ re: 6, im: 6 });
  });
});
