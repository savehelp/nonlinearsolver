import { describe, expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments } from './documents';
import { prepare, roots } from './solver';
import { createWorkspace, loadWorkspace } from './workspace';
import type { ElementDefinition } from './elements';
import type { Configuration, Scope } from './types';

const oxideCapacitance = 3.9 * 8.854214871e-12 / 9e-9;
const processes = [
  { type: 'NMOSFET', polarity: 1, vto: .7, gamma: .45, phi: .9, ld: .08e-6, mobility: 350, clm: .034e-6 },
  { type: 'PMOSFET', polarity: -1, vto: -.8, gamma: .4, phi: .8, ld: .09e-6, mobility: 100, clm: .064e-6 },
];

function compile(source: string, definitions?: ElementDefinition[]): Configuration {
  const config = clone(starter);
  config.solver.tolerance = 1e-12;
  config.elementDefinitions = definitions;
  return compileDocuments(config, [{ id: 'circuit', title: 'Circuit', source }]);
}

function device(type: string, g: number, d: number, s: number, b?: number, parameters: Record<string, number> = {}) {
  return compile(`element ${type} M1
parameter t 0 1 0 1 sweep
${Object.entries(parameters).map(([name, value]) => `parameter M1.${name} ${value}`).join('\n')}
M1.g = ${g}; M1.d = ${d}; M1.s = ${s};
${b === undefined ? '' : `M1.b = ${b};`}
set_time_axis t
plot M1.id`);
}

function outcome(config: Configuration) {
  try { return roots(prepare(config, 0), config.solver, [], false); }
  catch (error) { return { roots: [], error: error instanceof Error ? error.message : String(error) }; }
}

function values(config: Configuration): Scope {
  const found = outcome(config);
  expect(found.error).toBe('');
  expect(found.roots).toHaveLength(1);
  return found.roots[0].values;
}

function relative(actual: number, expected: number, tolerance = 1e-10) {
  expect(Math.abs(actual / expected - 1)).toBeLessThan(tolerance);
}

describe.each(processes)('$type Level 1 channel model', process => {
  const { type, polarity: p, vto, gamma, phi, ld, mobility, clm } = process;
  const leff = .5e-6 - 2 * ld;
  const beta = mobility * 1e-4 * oxideCapacitance * 1e-6 / leff;
  const lambda = clm / leff;
  const source = 1.25;
  const gate = source + p * (Math.abs(vto) + 1);

  it('converts the supplied process units and uses effective length for beta and lambda', () => {
    const normal = values(device(type, gate, source + p * 2, source));
    relative(normal['M1.Leff'], leff);
    relative(normal['M1.Cox'], oxideCapacitance);
    relative(normal['M1.KP'], mobility * 1e-4 * oxideCapacitance);
    relative(normal['M1.K'], beta);
    relative(normal['M1.LAMBDA'], lambda);
    relative(normal['M1.id'], p * beta / 2 * (1 + 2 * lambda));

    const wide = values(device(type, gate, source + p * 2, source, undefined, { W: 2e-6 }));
    relative(wide['M1.id'], 2 * normal['M1.id']);
    relative(wide['M1.LAMBDA'], lambda);

    const long = values(device(type, gate, source + p * 2, source, undefined, { L: 1e-6 }));
    const longLength = 1e-6 - 2 * ld;
    relative(long['M1.Leff'], longLength);
    relative(long['M1.K'], beta * leff / longLength);
    relative(long['M1.LAMBDA'], clm / longLength);
    expect(Math.abs(long['M1.id'])).toBeLessThan(Math.abs(normal['M1.id']));
  });

  it('ties an omitted body to the named source and permits a separate reverse-biased body', () => {
    const tied = values(device(type, gate, source + p * 2, source));
    expect(tied['M1.b']).toBe(source);
    expect(tied['M1.vsb']).toBe(0);
    expect(tied['M1.VTH']).toBe(vto);

    const bodyBias = .6;
    const body = source - p * bodyBias;
    const biased = values(device(type, gate, source + p * 2, source, body));
    const threshold = p * (Math.abs(vto) + gamma * (Math.sqrt(phi + bodyBias) - Math.sqrt(phi)));
    expect(biased['M1.b']).toBe(body);
    expect(biased['M1.vsb']).toBeCloseTo(p * bodyBias, 12);
    expect(biased['M1.VTH']).toBeCloseTo(threshold, 12);
    expect(Math.abs(biased['M1.VTH'])).toBeGreaterThan(Math.abs(tied['M1.VTH']));
    expect(Math.abs(biased['M1.id'])).toBeLessThan(Math.abs(tied['M1.id']));
    relative(biased['M1.id'], p * beta / 2 * (1 - Math.abs(threshold - vto)) ** 2 * (1 + 2 * lambda));
  });

  it('matches cutoff, triode, saturation, and drain-to-source current polarity', () => {
    const off = values(device(type, source + p * .4, source + p * 2, source));
    expect(Math.abs(off['M1.id'])).toBe(0);
    const triode = values(device(type, gate, source + p * .25, source));
    relative(triode['M1.id'], p * beta * (.25 - .25 ** 2 / 2) * (1 + lambda * .25));
    const saturation = values(device(type, gate, source + p * 1.7, source));
    relative(saturation['M1.id'], p * beta / 2 * (1 + lambda * 1.7));
    expect(Math.sign(triode['M1.id'])).toBe(p);
    expect(Math.sign(saturation['M1.id'])).toBe(p);
    expect(Math.abs(values(device(type, gate, source, source))['M1.id'])).toBe(0);
  });

  it('agrees in value and first slope across a body-shifted triode/saturation boundary', () => {
    const bias = .5, overdrive = .9, body = source - p * bias;
    const thresholdMagnitude = Math.abs(vto) + gamma * (Math.sqrt(phi + bias) - Math.sqrt(phi));
    const boundaryGate = source + p * (thresholdMagnitude + overdrive);
    const current = (drainBias: number, gateVoltage = boundaryGate) => p * values(device(type, gateVoltage, source + p * drainBias, source, body))['M1.id'];
    const h = 1e-6;
    const at = current(overdrive), below = current(overdrive - h), above = current(overdrive + h);
    relative(at, beta / 2 * overdrive ** 2 * (1 + lambda * overdrive));
    const drainSlope = beta / 2 * overdrive ** 2 * lambda;
    relative((at - below) / h, drainSlope, 2e-5);
    relative((above - at) / h, drainSlope, 2e-5);
    const gateSlope = beta * overdrive * (1 + lambda * overdrive);
    relative((at - current(overdrive, boundaryGate - p * h)) / h, gateSlope, 2e-6);
    relative((current(overdrive, boundaryGate + p * h) - at) / h, gateSlope, 2e-6);
  });

  it('uses the same channel law with opposite current when the named terminals are exchanged', () => {
    const bodyBias = .6, body = source - p * bodyBias;
    const thresholdMagnitude = Math.abs(vto) + gamma * (Math.sqrt(phi + bodyBias) - Math.sqrt(phi));
    const overdrive = 1, gateVoltage = source + p * (thresholdMagnitude + overdrive);
    for (const drainBias of [.25, 1.7]) {
      const normal = values(device(type, gateVoltage, source + p * drainBias, source, body));
      const reversed = values(device(type, gateVoltage, source, source + p * drainBias, body));
      relative(reversed['M1.id'], -normal['M1.id']);
      expect(reversed['M1.VTH']).toBeCloseTo(p * thresholdMagnitude, 12);
      expect(reversed['M1.VTH']).toBeCloseTo(normal['M1.VTH'], 12);
      expect(reversed['M1.source_voltage']).toBe(source);
      expect(reversed['M1.drain_voltage']).toBe(source + p * drainBias);
      expect(reversed['M1.channel_vsb']).toBeCloseTo(bodyBias, 12);
      expect(reversed['M1.channel_vds']).toBeCloseTo(drainBias, 12);
      expect(reversed['M1.vds']).toBeCloseTo(-p * drainBias, 12);
      // Public voltage members retain the signs of the named d/s pins.
      expect(reversed['M1.vgs']).toBeCloseTo(gateVoltage - source - p * drainBias, 12);
      expect(reversed['M1.vsb']).toBeCloseTo(p * (bodyBias + drainBias), 12);
      const expectedMagnitude = drainBias < overdrive
        ? beta * (overdrive * drainBias - drainBias ** 2 / 2) * (1 + lambda * drainBias)
        : beta / 2 * overdrive ** 2 * (1 + lambda * drainBias);
      relative(Math.abs(reversed['M1.id']), expectedMagnitude);
    }
  });

  it('finds cutoff relative to the selected source in either terminal orientation', () => {
    const body = source - p * .6, gateVoltage = source + p * .4;
    for (const [d, s] of [[source + p * 2, source], [source, source + p * 2]]) {
      const off = values(device(type, gateVoltage, d, s, body));
      expect(Math.abs(off['M1.id'])).toBe(0);
      expect(off['M1.source_voltage']).toBe(source);
      expect(off['M1.vov']).toBeLessThan(0);
    }
  });

  it('matches current and voltage slopes as the named drain crosses the named source', () => {
    const bodyBias = .6, body = source - p * bodyBias, overdrive = 1;
    const thresholdMagnitude = Math.abs(vto) + gamma * (Math.sqrt(phi + bodyBias) - Math.sqrt(phi));
    const gateVoltage = source + p * (thresholdMagnitude + overdrive);
    const current = (drainOffset: number, gateValue = gateVoltage) => values(device(type, gateValue, source + drainOffset, source, body))['M1.id'];
    const h = 1e-6, at = current(0), below = current(-h), above = current(h);
    expect(Math.abs(at)).toBe(0);
    expect(below).toBeLessThan(0); expect(above).toBeGreaterThan(0);
    relative((at - below) / h, beta * overdrive, 3e-6);
    relative((above - at) / h, beta * overdrive, 3e-6);
    // At zero channel voltage the current stays zero while the gate changes.
    expect(current(0, gateVoltage - h)).toBe(0);
    expect(current(0, gateVoltage + h)).toBe(0);
    for (const delta of [-h, h]) {
      const gateSlope = (current(delta, gateVoltage + h) - current(delta, gateVoltage - h)) / (2 * h);
      expect(Math.abs(gateSlope)).toBeLessThan(beta * h * 1.01);
    }
  });

  it('keeps a default body tied to the named source and rejects forward-biased body junctions', () => {
    for (const config of [
      // Reversal alone is supported, but the omitted body stays tied to s.
      // Here that physical connection forward-biases the new source junction.
      device(type, gate, source - p * .1, source),
      device(type, gate, source + p * 2, source, source + p * .1),
      device(type, gate, source + p * 2, source, source + p * 10),
      device(type, gate, source - p * .5, source, source - p * .4),
    ]) {
      const found = outcome(config);
      expect(found.roots).toEqual([]);
      expect(found.error).not.toBe('');
    }
  });

  it('rejects invalid geometry and process values instead of returning a physical root', () => {
    const invalid: Record<string, number>[] = [
      { W: 0 }, { L: 2 * ld }, { L: ld }, { LD: -ld }, { TOX: 0 },
      { PHI: 0 }, { UO: -1 }, { GAMMA: -.1 }, { CLM_C: -1e-8 },
    ];
    for (const parameters of invalid) {
      const found = outcome(device(type, gate, source + p * 2, source, undefined, parameters));
      expect(found.roots).toEqual([]);
      expect(found.error).not.toBe('');
    }
  });
});

describe('complementary and saved MOSFET circuits', () => {
  it('balances signed NMOS and PMOS currents and preserves explicit bodies through workspace export', () => {
    const source = `element NMOSFET N1
element PMOSFET P1
parameter vin 1.6 .1 1 2 sweep
unknown out .5
N1.g = vin; N1.s = 0; N1.d = out; N1.b = -.5;
P1.g = vin; P1.s = 3.3; P1.d = out; P1.b = 3.8;
N1.id + P1.id = 0;
out >= 0; out <= 3.3;
set_time_axis vin
plot out
plot N1.id
plot P1.id`;
    const config = compile(source), file = createWorkspace(config);
    const restored = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(restored.documents).toEqual(config.documents);
    expect(file.elements?.map(definition => definition.name)).toEqual(['NMOSFET', 'PMOSFET']);
    for (const definition of file.elements ?? []) expect(definition.terminalDefaults).toEqual({ b: 's' });
    const before = roots(prepare(config, 1.6), config.solver, [], false);
    const after = roots(prepare(restored, 1.6), restored.solver, [], false);
    expect(before.error).toBe(''); expect(after.error).toBe('');
    expect(before.roots).toHaveLength(1); expect(after.roots).toHaveLength(1);
    const first = before.roots[0].values, saved = after.roots[0].values;
    expect(first.out).toBeGreaterThan(0); expect(first.out).toBeLessThan(3.3);
    expect(first['N1.id']).toBeGreaterThan(0); expect(first['P1.id']).toBeLessThan(0);
    expect(first['N1.id'] + first['P1.id']).toBeCloseTo(0, 11);
    expect(first['N1.b']).toBe(-.5); expect(first['P1.b']).toBe(3.8);
    expect(saved.out).toBeCloseTo(first.out, 10);
    expect(saved['N1.id']).toBeCloseTo(first['N1.id'], 12);
  });

  it('keeps a saved legacy NMOS definition and its parameter overrides usable', () => {
    const old: ElementDefinition = {
      name: 'NMOSFET', mode: 'real', terminals: ['g', 'd', 's'],
      parameters: { VTH: { value: .7 }, K: { value: .001 }, LAMBDA: { value: .02 } },
      unknowns: { id: .0005 },
      equations: ['vgs = g - s', 'vds = d - s', 'id = if(vgs <= VTH, 0, if(vds < vgs - VTH, K*((vgs - VTH)*vds - vds^2/2)*(1 + LAMBDA*vds), K/2*(vgs - VTH)^2*(1 + LAMBDA*vds)))', 'vds >= 0'],
    };
    const config = compile(`element NMOSFET M1
parameter t 0 1 0 1 sweep
parameter M1.VTH .8
M1.g = 1.6; M1.d = 2; M1.s = 0;
set_time_axis t
plot M1.id`, [old]);
    const file = createWorkspace(config), restored = loadWorkspace(JSON.parse(JSON.stringify(file)));
    expect(file.elements?.find(definition => definition.name === 'NMOSFET')).toEqual(old);
    relative(values(restored)['M1.id'], .001 / 2 * .8 ** 2 * 1.04);
  });
});
