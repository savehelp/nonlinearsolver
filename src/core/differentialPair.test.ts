import { expect, it } from 'vitest';
import { clone, starter } from '../examples';
import { compileDocuments } from './documents';
import { prepare, sweep } from './solver';

const circuit = `
parameter vin 0 .05 0 .5 sweep
parameter Vdd 3
parameter R1 2200
parameter vcm 2
vin1 = vcm + vin/2;
vin2 = vcm - vin/2;
element NMOSFET M1
M1.g = vin1;
M1.s = vs;
M1.d = vx;
M1.b = 0;
M1.W = 100e-6;
element NMOSFET M2
M2.g = vin2;
M2.s = vs;
M2.d = vy;
M2.b = 0;
M2.W = 100e-6;
M1.id + M2.id = 1e-3;
element PMOSFET M3
M3.g = 1.94;
M3.s = Vdd;
M3.d = vx;
M3.id = M1.id;
M3.W = 100e-6;
element PMOSFET M4
M4.g = 1.94;
M4.s = Vdd;
M4.d = vy;
M4.id = M2.id;
M4.W = 100e-6;
set_time_axis vin
plot M1.d
`;
const gain = `
M1.id * M1.LAMBDA * ro1 = (1+M1.LAMBDA*(M1.d - M1.s));
M3.id * M3.LAMBDA * ro3 = (1+M3.LAMBDA*(M3.s - M3.d));
(M1.g - M1.s - M1.VTH) * gm1 = 2 * M1.id;
(ro1+ro3) * A = gm1 * (ro1 * ro3);
plot A*Vdd
`;
it('solves multiplied gain and resistance equations downstream of the differential pair', () => {
  const config = compileDocuments(clone(starter), [{ id: 'pair', title: 'Pair', source: circuit + gain }]);
  const system = prepare(config, 0);

  for (const name of ['A', 'ro1', 'ro3', 'gm1']) expect(system.unknowns.some(variable => variable.name === name)).toBe(false);
  const result = sweep(config);
  expect(result.solved).toBe(11);
  for (const point of result.branches.flatMap(branch => branch.points)) {
    const { values } = point;
    expect(values['M1.id'] + values['M2.id']).toBeCloseTo(.001, 10);
    expect(values['M1.W']).toBe(100e-6);
    expect(values['M3.id']).toBeCloseTo(values['M1.id'], 10);
    expect(values['M3.isd']).toBe(values['M3.id']);
    expect(values.A).toBeCloseTo(values.gm1 / (1 / values.ro1 + 1 / values.ro3), 8);
  }
}, 15000);