import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments } from './documents';
import { prepare, roots, sweep } from './solver';
import { createWorkspaceArchive, loadWorkspaceArchive } from './workspaceArchive';
import type { Configuration } from './types';

const processes = [{ type: 'NMOSFET', polarity: 1 }, { type: 'PMOSFET', polarity: -1 }];

function compile(source: string): Configuration {
  const config = clone(starter);
  config.solver.tolerance = 1e-12;
  return compileDocuments(config, [{ id: 'circuit', title: 'Circuit', source }]);
}

function reversalCircuit(type: string, polarity: number, first = 'd', second = 's') {
  return compile(`element ${type} M1
parameter delta 0 .1 -1 1 sweep
M1.g = ${polarity * 2.5};
M1.${first} = delta;
M1.${second} = 0;
M1.b = ${-polarity * 2};
set_time_axis delta
plot M1.id`);
}

describe.each(processes)('$type source/drain reversal integration', ({ type, polarity }) => {
  it('sweeps continuously through zero current with fixed drain and source pins', () => {
    const config = reversalCircuit(type, polarity), result = sweep(config);
    expect(result.solved).toBe(21); expect(result.total).toBe(21);
    expect(result.failures).toEqual([]);
    expect(result.branches).toHaveLength(1);
    const points = result.branches[0].points;
    expect(points).toHaveLength(21);
    expect(points.map(point => point.parameter)).toEqual([...points.map(point => point.parameter)].sort((a, b) => a - b));
    for (const point of points) {
      expect(point.values['M1.t1']).toBeCloseTo(point.parameter, 12);
      expect(point.values['M1.d']).toBeCloseTo(point.parameter, 12);
      expect(point.values['M1.t2']).toBe(0); expect(point.values['M1.s']).toBe(0);
      expect(point.values['M1.source_voltage']).toBe(polarity === 1 ? Math.min(point.parameter, 0) : Math.max(point.parameter, 0));
      expect(point.values['M1.channel_vds']).toBeCloseTo(Math.abs(point.parameter), 12);
      expect(point.values['M1.channel_vsb']).toBeGreaterThanOrEqual(1);
      expect(Math.abs(point.parameter) < 1e-12 ? Math.abs(point.values['M1.id']) : Math.sign(point.values['M1.id']))
        .toBe(Math.abs(point.parameter) < 1e-12 ? 0 : Math.sign(point.parameter));
    }
  });

  it('keeps older terminal aliases equivalent to the drain and source pins', () => {
    const canonical = reversalCircuit(type, polarity, 'd', 's');
    for (const config of [reversalCircuit(type, polarity, 't1', 't2'), reversalCircuit(type, polarity, 'd', 't2'), reversalCircuit(type, polarity, 't1', 's')]) {
      for (const delta of [-.5, 0, .5]) {
        const expected = roots(prepare(canonical, delta), canonical.solver, [], false);
        const actual = roots(prepare(config, delta), config.solver, [], false);
        expect(expected.error).toBe(''); expect(actual.error).toBe('');
        expect(actual.roots).toHaveLength(1);
        for (const name of ['id', 'VTH', 'channel_vgs', 'channel_vsb', 'source_voltage']) {
          expect(actual.roots[0].values[`M1.${name}`]).toBeCloseTo(expected.roots[0].values[`M1.${name}`], 12);
        }
      }
    }
  });

  it('solves the same resistor-loaded circuit with the named d/s pins reversed', () => {
    const supply = polarity === 1 ? 0 : 3.3;
    const threshold = polarity === 1 ? .7 : .8;
    const source = (reversed: boolean) => `element ${type} M1
parameter t 0 1 0 1 sweep
parameter R 1000
M1.g = ${supply + polarity * (threshold + .8)};
M1.b = ${supply};
${reversed
      ? `M1.d = ${supply}; M1.s = ${supply + polarity * 3.3} + M1.id*R;`
      : `M1.s = ${supply}; M1.d = ${supply + polarity * 3.3} - M1.id*R;`}
set_time_axis t
plot M1.id`;
    const ordinary = compile(source(false)), reversed = compile(source(true));
    const before = roots(prepare(ordinary, 0), ordinary.solver);
    const after = roots(prepare(reversed, 0), reversed.solver);
    expect(before.roots).toHaveLength(1); expect(after.roots).toHaveLength(1);
    const normal = before.roots[0].values, reverse = after.roots[0].values;
    expect(reverse['M1.source_voltage']).toBeCloseTo(supply, 12);
    expect(reverse['M1.id']).toBeCloseTo(-normal['M1.id'], 12);
    expect(reverse['M1.drain_voltage']).toBeCloseTo(normal['M1.drain_voltage'], 10);
    expect(reverse['M1.s']).toBeCloseTo(supply + polarity * 3.3 + reverse['M1.id'] * 1000, 10);
  });

  it('preserves drain/source wiring, compatible aliases, and both current directions through a workspace ZIP', () => {
    const config = reversalCircuit(type, polarity);
    const restored = loadWorkspaceArchive(createWorkspaceArchive(config));
    expect(restored.documents).toEqual(config.documents);
    expect(restored.elementDefinitions!.find(definition => definition.name === type)?.terminalAliases).toEqual({ t1: 'd', t2: 's' });
    const before = sweep(config), after = sweep(restored);
    expect(after.failures).toEqual([]);
    expect(after.solved).toBe(21);
    expect(after.branches.map(branch => branch.points.map(point => ({ parameter: point.parameter, id: point.values['M1.id'], b: point.values['M1.b'] }))))
      .toEqual(before.branches.map(branch => branch.points.map(point => ({ parameter: point.parameter, id: point.values['M1.id'], b: point.values['M1.b'] }))));
  });
});
