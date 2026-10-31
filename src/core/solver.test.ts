import { describe, expect, it } from 'vitest';
import { compile, residual, equationStatements } from './expression';
import { prepare, roots, solve, sweep } from './solver';
import { clone, examples, starter } from '../examples';
import { compileDocuments, ensureDocuments } from './documents';
import type { Configuration } from './types';
import { reconcileSweep } from './variables';
import { yExpressions } from './axes';
import { numericExpression } from './numeric';
function generic(equations: string, unknowns = ['x']): Configuration { const c = clone(examples[2]); c.equations = equations; c.regions = []; c.variables = [...unknowns.map(name => ({ name, kind: 'unknown' as const, value: .8, min: -5, max: 5 })), { name: 'p', kind: 'parameter', value: 0, min: -1, max: 1 }]; c.axes = { x: 'p', y: unknowns[0] }; return c; }
describe('safe math expressions', () => {
  it('evaluates scientific notation and numeric expressions for parameter controls', () => {
    expect(numericExpression('9e-9')).toBeCloseTo(9e-9, 18);
    expect(numericExpression('9E-9')).toBeCloseTo(9e-9, 18);
    expect(numericExpression('9*10^(-9)')).toBeCloseTo(9e-9, 18);
    expect(numericExpression('1e3 + 2.2k')).toBeCloseTo(3200);
    expect(numericExpression('sqrt(4) / 2')).toBe(1);
    expect(() => numericExpression('9*')).toThrow();
    expect(() => numericExpression('a*2')).toThrow('numbers');
    expect(() => numericExpression('1/0')).toThrow('Non-finite');
    expect(() => numericExpression('window.alert(1)')).toThrow();
  });
  it('splits Y expressions without splitting function arguments', () => {
    expect(yExpressions('y, max(y, 0), if(x > 0, y, -y)')).toEqual(['y', 'max(y, 0)', 'if(x > 0, y, -y)']);
    expect(() => yExpressions('y,')).toThrow('Y expressions');
  });
  it('uses semicolons to delimit multiline equations and ignores comment punctuation', () => {
    const source = '# heading; ignored\nx +\n y = 3; # inline; ignored\nx - y\n = 1;';
    expect(equationStatements(source)).toEqual(['x +\n y = 3', 'x - y\n = 1']);
    expect(equationStatements(source)).toHaveLength(2);
    const c = generic(source, ['x', 'y']); const root = solve(prepare(c), [0, 0], c.solver);
    expect(root.values.x).toBeCloseTo(2); expect(root.values.y).toBeCloseTo(1);
  });
  it('evaluates multiline nested if expressions without braces', () => {
    const c = generic('x = if(\n p <= 0,\n 0,\n if(p < 1,\n   p^2,\n   sqrt(p)\n )\n);');
    for (const [p, expected] of [[-1, 0], [.5, .25], [4, 2]]) expect(solve(prepare(c, p), [.8], c.solver).values.x).toBeCloseTo(expected);
  });
  it('explains missing terminators and does not count physical lines as equations', () => {
    expect(() => equationStatements('x=1;\ny=2')).toThrow('semicolon');
    expect(() => residual(equationStatements('x=1\ny=2;')[0])).toThrow('semicolon');
    expect(() => equationStatements('x=1;\ny=')).toThrow('semicolon');
    expect(equationStatements('x=1; y=2;')).toHaveLength(2);
  });
  it('supports newline-separated systems without semicolons', () => {
    expect(equationStatements('x=1\ny=if(\n x>0,\n 2, 3\n)')).toHaveLength(2);
    expect(equationStatements('# only a comment;\n')).toEqual([]);
  });
  it('parses scientific and engineering notation', () => { expect(compile('2.2k * 500u + 1e-3').evaluate({})).toBeCloseTo(1.101); expect(compile('2^3^2').evaluate({})).toBe(512); expect(compile('-2^2').evaluate({})).toBe(-4); });
  it('identifies variables and equality residuals', () => { expect(residual('(VDD - VD)/RD = ID').variables.sort()).toEqual(['ID', 'RD', 'VD', 'VDD']); expect(residual('x = 3').evaluate({ x: 3 })).toBe(0); });
  it('evaluates piecewise branches lazily', () => { expect(compile('if(x <= 0, 0, log(x))').evaluate({ x: 0 })).toBe(0); expect(compile('x > 0 ? sqrt(x) : 0').evaluate({ x: -1 })).toBe(0); expect(compile('0 && log(-1)').evaluate({})).toBe(0); });
  it('rejects arbitrary code and invalid evaluations', () => { expect(() => compile('window.alert(1)')).toThrow(); expect(() => compile('constructor(1)')).toThrow(); expect(() => compile('sqrt(-1)').evaluate({})).toThrow(); expect(() => compile('1/0').evaluate({})).toThrow(); });
});
describe('nonlinear engine', () => {
  it('applies inclusive validity bounds using numbers, reversed inequalities, and sweep parameters', () => {
    const c = clone(starter); c.equations = 'y = x;'; c.constraints = '0 <= y\ny <= x + 2\ny <= 10^2';
    const system = prepare(c, 3); expect(system.unknowns[0].min).toBe(0); expect(system.unknowns[0].max).toBe(5);
    expect(solve(system, [1], c.solver).values.y).toBeCloseTo(3);
  });
  it('continues to check strict and compound conditions without treating them as bounds', () => {
    const c = clone(starter); c.equations = 'y = x;'; c.constraints = 'y > 0\ny < 10 && y != 5';
    const system = prepare(c, 1); expect(system.unknowns[0].min).toBeUndefined(); expect(system.unknowns[0].max).toBeUndefined();
    expect(system.valid({ x: 0, y: 0, a: 1, b: 0 })).toBe(false);
    expect(system.valid({ x: 1, y: 1, a: 1, b: 0 })).toBe(true);
  });
  it('allows equal inclusive bounds and does not abort a sweep for contradictory conditions', () => {
    const c = clone(starter); c.equations = 'y = 5;'; c.constraints = 'y >= 5\ny <= 5';
    expect(solve(prepare(c, 1), [1], c.solver).values.y).toBe(5);
    c.constraints = 'y >= 0\ny <= x'; c.sweep.min = -1; c.sweep.max = 1; c.sweep.points = 3; c.equations = 'y = x;';
    const r = sweep(c); expect(r.solved).toBe(2); expect(r.failures.map(f => f.index)).toContain(0);
  });
  it('solves coupled linear equations and reports the Jacobian', () => { const c = generic('2*x + y = 5\nx - y = 1', ['x', 'y']); const r = solve(prepare(c), [.8, .8], c.solver); expect(r.values.x).toBeCloseTo(2, 7); expect(r.values.y).toBeCloseTo(1, 7); expect(r.jacobian[0][0]).toBeCloseTo(2); expect(r.norm).toBeLessThan(1e-8); });
  it('solves a known nonlinear root', () => { const c = generic('x^2 = 2'); const r = solve(prepare(c), [1], c.solver); expect(r.values.x).toBeCloseTo(Math.SQRT2, 7); });
  it('refines a repeated root before accepting or deduplicating it', () => {
    const c = clone(starter); c.equations = 'y^2 = x; y >= 0;';
    const system = prepare(c, 0), root = solve(system, [1], c.solver);
    expect(root.values.y).toBeCloseTo(0, 8);
    const found = roots(system, c.solver).roots;
    expect(found).toHaveLength(1);
    expect(found[0].values.y).toBeCloseTo(0, 8);
  });
  it('resolves nearby positive roots without rounding them to the repeated root', () => {
    const c = clone(starter); c.equations = 'y^2 = x; y >= 0;';
    const root = solve(prepare(c, 1e-12), [1], c.solver);
    expect(root.values.y).toBeCloseTo(1e-6, 8);
    expect(root.values.y).toBeGreaterThan(0);
  });
  it('rejects a small stationary residual when no real root exists', () => {
    const c = clone(starter); c.equations = 'y^2 = -1e-12;';
    expect(roots(prepare(c), c.solver).roots).toEqual([]);
  });
  it('accepts an exact root with a singular Jacobian', () => {
    const c = clone(starter); c.equations = 'y^2 = x;';
    const root = solve(prepare(c, 0), [0], c.solver);
    expect(root.values.y).toBe(0); expect(root.norm).toBe(0);
    expect(root.iterations).toBe(0); expect(root.jacobian).toEqual([[0]]);
  });
  it('scales convergence corrections relative to large unknown values', () => {
    const c = clone(starter); c.equations = '(y/1e12)^2 = 2;';
    const root = solve(prepare(c), [1e12], c.solver);
    expect(root.values.y / 1e12).toBeCloseTo(Math.SQRT2, 8);
  });
  it('discovers and deduplicates three roots', () => { const c = generic('x^3-x = 0'); const r = roots(prepare(c), { ...c.solver, starts: 24 }).roots; expect(r).toHaveLength(3); expect(r.map(r => Math.round(r.values.x)).sort()).toEqual([-1, 0, 1]); });
  it('enforces bounds and validity conditions', () => { const c = generic('x^2 = 1'); c.constraints = 'x > 0'; const found = roots(prepare(c), c.solver).roots; expect(found).toHaveLength(1); expect(found[0].values.x).toBeCloseTo(1); c.variables[0].min = 2; expect(roots(prepare(c), c.solver).roots).toHaveLength(0); });
  it('reports invalid evaluations and nonconvergence', () => { let c = generic('sqrt(-1) = x'); expect(() => solve(prepare(c), [1], c.solver)).toThrow('Non-finite'); c = generic('x^2 = -1'); expect(roots(prepare(c), c.solver).roots).toHaveLength(0); });
  it('detects configuration problems', () => { const c = generic('x=1\nx=2'); expect(() => prepare(c)).toThrow('Overdetermined'); c.equations = ''; expect(() => prepare(c)).toThrow('Underdetermined'); c.equations = 'x = missing'; expect(() => prepare(c)).toThrow('Underdetermined'); });
  it('resolves derived dependencies and detects cycles', () => { const c = generic('x = a'); c.variables.push({ name: 'a', kind: 'derived', value: 0, expression: 'b + 1' }, { name: 'b', kind: 'derived', value: 0, expression: 'p + 2' }); expect(solve(prepare(c), [0], c.solver).values.x).toBeCloseTo(3); c.variables[3].expression = 'a'; expect(() => solve(prepare(c), [0], c.solver)).toThrow('circular'); });
  it('handles a piecewise region boundary', () => { const c = generic('x = if(p <= 0, 0, p^2)'); for (const p of [-1, 0, 1]) expect(solve(prepare(c, p), [.8], c.solver).values.x).toBeCloseTo(p <= 0 ? 0 : 1, 7); });
});
describe('sweeps and examples', () => {
  it('solves an unknown fixed by an equation while sweeping another parameter', () => {
    const c = clone(starter); c.equations = 'x = 5; y = x*p;';
    c.variables = [{ name: 'x', kind: 'unknown', value: 1 }, { name: 'y', kind: 'unknown', value: 1 }, { name: 'p', kind: 'parameter', value: 1 }];
    c.sweep = { ...c.sweep, parameter: 'p', min: 0, max: 2, points: 11 }; c.axes = { x: 'p', y: 'x, y' };
    const r = sweep(c); expect(r.solved).toBe(11); expect(r.failures).toHaveLength(0);
    const points = r.branches.flatMap(b => b.points); expect(points).toHaveLength(11);
    for (const point of points) { expect(point.values.x).toBeCloseTo(5); expect(point.values.y).toBeCloseTo(5 * point.parameter); }
  });
  it('evaluates multiple Y expressions on the same roots', () => {
    const c = clone(starter); c.axes.y = 'y, y^2, max(y, 0)';
    const r = sweep(c); expect(r.solved).toBe(c.sweep.points); expect(r.branches).toHaveLength(1);
    for (const p of r.branches[0].points) { expect(p.ys[0]).toBeCloseTo(p.x); expect(p.ys[1]).toBeCloseTo(p.x ** 2); expect(p.ys[2]).toBeCloseTo(Math.max(p.x, 0)); }
  });
  it('keeps valid curves when another Y expression has an invalid domain', () => {
    const c = clone(starter); c.axes.y = 'sqrt(x), y'; c.sweep.points = 11;
    const r = sweep(c); expect(r.solved).toBe(11); expect(r.failures).toHaveLength(5);
    const negative = r.branches.flatMap(b => b.points).filter(p => p.x < 0);
    expect(negative).toHaveLength(5); expect(negative.every(p => p.ys[0] === null && Math.abs(p.ys[1]! - p.x) < 1e-6)).toBe(true);
    expect(r.failures[0].reason).toContain('sqrt(x)');
  });
  it('includes dependencies used only by an additional Y expression', () => {
    const c = clone(starter); c.equations = 'y=x;'; c.axes.y = 'y, extra';
    c.variables.push({ name: 'extra', kind: 'derived', value: 0, expression: 'a*x+b' });
    const r = sweep(c); expect(r.failures).toHaveLength(0); expect(r.branches[0].points[0].values).toHaveProperty('extra');
  });
  it('reports the missing low-vx points caused by the supplied i1 upper bound', () => {
    const c = clone(starter); c.equations = 'vd1=vdd;\nvg1=vdd;\nvs1=vx;\ni1=(vg1-vs1-vth)^2;';
    c.variables = [
      { name: 'vdd', kind: 'parameter', value: 5 },
      ...['vd1', 'vg1', 'vs1'].map(name => ({ name, kind: 'unknown' as const, value: 1 })),
      { name: 'i1', kind: 'unknown', value: 1, min: 0, max: 10 },
      { name: 'vx', kind: 'parameter', value: 1 },
      { name: 'B', kind: 'parameter', value: 1 },
      { name: 'vth', kind: 'parameter', value: .7 },
    ];
    c.sweep = { ...c.sweep, parameter: 'vx', min: 0, max: 5, points: 100, release: 'B' }; c.axes = { x: 'vx', y: 'i1' };
    const bounded = sweep(c); expect(bounded.solved).toBe(77); expect(bounded.failures).toHaveLength(23);
    expect(bounded.failures[0].reason).toContain('i1 is at its maximum (10)');
    const points = bounded.branches.flatMap(b => b.points); expect(Math.min(...points.map(p => p.x))).toBeCloseTo(5 * 23 / 99);
    delete c.variables.find(v => v.name === 'i1')!.max;
    const full = sweep(c); expect(full.solved).toBe(100); expect(full.failures).toHaveLength(0);
    const first = full.branches.flatMap(b => b.points).find(p => p.index === 0)!;
    expect(first.x).toBe(0); expect(first.y).toBeCloseTo(18.49, 6);
  });
  it('rebuilds a y=x sweep after removing and replacing all declarations', () => {
    const empty = compileDocuments(clone(starter), [{ id: 'model', title: 'Model', source: '' }]);
    expect(empty.variables).toEqual([]); expect(empty.sweep.parameter).toBe('');
    const source = 'unknown y\nparameter x 0 .1 -5 5 sweep\ny = x;\nset_time_axis x\nplot y';
    const rebuilt = compileDocuments(empty, [{ id: 'model', title: 'Model', source }]);
    expect(rebuilt.sweep.parameter).toBe('x');
    const result = sweep(rebuilt); expect(result.solved).toBe(101); expect(result.branches).toHaveLength(1);
    expect(result.branches[0].points[0].y).toBeCloseTo(-5);
    expect(result.branches[0].points.at(-1)!.y).toBeCloseTo(5);
  });
  it('clears stale sweep selections and applies changes to declaration kinds', () => {
    const config = clone(starter); config.sweep.parameter = 'deleted'; reconcileSweep(config, false);
    expect(config.sweep.parameter).toBe('');
    const selected = compileDocuments(config, [{ id: 'model', title: 'Model', source: 'unknown y\nparameter x 0 1 -5 5 sweep\ny = x;' }]);
    expect(selected.sweep.parameter).toBe('x');
    const changed = compileDocuments(selected, [{ id: 'model', title: 'Model', source: 'unknown y\nunknown x\ny = x;' }]);
    expect(changed.sweep.parameter).toBe('');
    expect(changed.variables.find(variable => variable.name === 'x')?.kind).toBe('unknown');
  });
  it('does not turn slider ranges into hard bounds when a declaration becomes an unknown', () => {
    const config = clone(starter);
    const documents = ensureDocuments(config).map(document => ({ ...document, source: document.source.replace('parameter a 1 0.1 -5 5', 'unknown a 1') }));
    const changed = compileDocuments(config, documents), variable = changed.variables.find(variable => variable.name === 'a')!;
    expect(variable.kind).toBe('unknown'); expect(variable.min).toBeUndefined(); expect(variable.max).toBeUndefined(); expect(variable.step).toBeUndefined();
  });
  it('starts with a generic linear equation and user-defined parameters only', () => {
    const c = clone(starter); const r = sweep(c);
    expect(c.variables.map(v => v.name)).toEqual(['y', 'x', 'a', 'b']);
    expect(r.solved).toBe(c.sweep.points);
    expect(r.branches).toHaveLength(1);
    expect(r.branches.flatMap(b => b.points).every(p => Math.abs(p.y - p.x) < 1e-7)).toBe(true);
  });
  it('does not require leftover transistor parameters, unknowns, or derived definitions', () => {
    const c = clone(examples[0]); c.equations = 'VD = VG;';
    c.variables = c.variables.filter(v => !['VTH', 'K', 'LAMBDA', 'VDD', 'RD'].includes(v.name));
    c.variables = c.variables.filter(v => v.name !== 'VOV');
    c.variables.push({ name: 'VOV', kind: 'derived', value: 0, expression: 'missing + 1' });
    c.regions = [{ name: 'Legacy region', condition: 'missingRegionVariable > 0', color: '#ffffff' }];
    const r = sweep(c); expect(r.solved).toBe(c.sweep.points); expect(r.unknowns).toEqual(['VD']);
    expect(r.branches[0].points[0].values).not.toHaveProperty('ID');
    expect(r.branches[0].points[0].values).not.toHaveProperty('VOV');
  });
  it('retains parameters referenced indirectly by derived expressions', () => {
    const c = generic('x = result;');
    c.variables.push({ name: 'result', kind: 'derived', value: 0, expression: 'gain * p' }, { name: 'gain', kind: 'parameter', value: 2 });
    const r = solve(prepare(c, .5), [0], c.solver); expect(r.values.x).toBeCloseTo(1); expect(r.values.gain).toBe(2);
  });
  it('plots a line after replacing the common-source equations with VD=VG and ID=1', () => {
    const c = clone(examples[0]); c.equations = 'VD = VG;\nID = 1;';
    const r = sweep(c); expect(r.solved).toBe(c.sweep.points); expect(r.failures).toHaveLength(0); expect(r.branches).toHaveLength(1);
    for (const p of r.branches[0].points) { expect(p.y).toBeCloseTo(p.x, 7); expect(p.values.ID).toBeCloseTo(1, 7); }
  });
  it('explains an explicit bound that prevents any sweep solution', () => {
    const c = clone(examples[0]); c.equations = 'VD = VG; ID = 1;'; c.variables.find(v => v.name === 'ID')!.max = .01;
    expect(() => sweep(c)).toThrow(/ID is at its maximum \(0.01\)/);
  });
  it('tracks separate cubic branches without crossing gaps', () => { const c = clone(examples[2]); c.sweep.points = 61; const result = sweep(c); expect(result.solved).toBe(61); const center = result.branches.flatMap(b => b.points.filter(p => Math.abs(p.parameter) < 1e-9)); expect(center).toHaveLength(3); for (const b of result.branches) for (let i = 1; i < b.points.length; i++) expect(b.points[i].index - b.points[i - 1].index).toBe(1); });
  it('uses computed coordinate pairs for arbitrary axes', () => { const c = generic('x^2 = 4'); c.axes = { x: 'x + p', y: 'x^2' }; c.sweep.points = 5; const r = sweep(c); expect(r.branches.flatMap(b => b.points).every(p => Math.abs(p.y - 4) < 1e-7)).toBe(true); });
  it('preserves failed points as gaps', () => { const c = generic('x^2 = p^2 - 0.1'); c.sweep = { ...c.sweep, min: -1, max: 1, points: 11 }; const r = sweep(c); expect(r.failures.length).toBeGreaterThan(0); for (const b of r.branches) expect(b.points.every(p => p.parameter < 0) || b.points.every(p => p.parameter > 0)).toBe(true); });
  it('supports logarithmic and constrained sweeps', () => { const c = generic('x = 2*p'); c.sweep = { ...c.sweep, min: .1, max: 1, points: 3, logarithmic: true }; expect(sweep(c).branches[0].points[1].parameter).toBeCloseTo(Math.sqrt(.1)); c.sweep = { ...c.sweep, mode: 'constrained', parameter: 'x', release: 'p', logarithmic: false }; const r = sweep(c); expect(r.solved).toBe(3); expect(r.branches[0].points[0].values.p).toBeCloseTo(.05); });
  it('validates NMOS against the analytical zero-lambda saturation result', () => { const c = clone(examples[0]); c.variables.find(v => v.name === 'LAMBDA')!.value = 0; const r = solve(prepare(c, 1.2), [3, .0001], c.solver); expect(r.values.ID).toBeCloseTo(.001 / 2 * .5 ** 2, 10); expect(r.values.VD).toBeCloseTo(3.3 - 2200 * r.values.ID, 8); });
  it('solves both transistor examples over their full input range', () => { for (const example of examples.slice(0, 2)) { const c = clone(example); c.sweep.points = 41; const r = sweep(c); expect(r.solved).toBe(41); expect(r.failures).toHaveLength(0); const points = r.branches.flatMap(b => b.points); expect(points.every(p => p.norm < 1e-7)).toBe(true); if (c.name === 'CMOS inverter') { expect(points.find(p => p.index === 0)!.values.VOUT).toBeCloseTo(3.3, 5); expect(points.find(p => p.index === 40)!.values.VOUT).toBeCloseTo(0, 5); } } });
});
