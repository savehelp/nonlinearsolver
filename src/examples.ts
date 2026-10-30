import type { Configuration, Variable } from './core/types';
import { migrateUnknownBounds } from './core/constraints';
import { migrateParameterSweepSettings } from './core/sweepPlan';
import { migrateEquationInputs } from './core/workspaceSyntax';
import { compileDocuments, validateDocuments } from './core/documents';
const parameter = (name: string, value: number, min: number, max: number, step: number): Variable => ({ name, value, min, max, step, kind: 'parameter' });
// Example guesses are starting points, not physical restrictions on edited equations.
const unknown = (name: string, value: number, min?: number, max?: number): Variable => ({ name, value, min, max, kind: 'unknown' });
const base = { constraints: '', solver: { tolerance: 1e-9, iterations: 100, starts: 12 }, sweep: { parameter: 'VG', min: 0, max: 3.3, points: 121, logarithmic: false, mode: 'free' as const, release: '' } };
export const examples: Configuration[] = [
  { ...base, name: 'NMOS common source', description: 'A resistor-loaded NMOS, from cutoff to saturation and triode.',
    equations: '# Drain-node KCL\n(VDD - VD) / RD = ID;\n\n# Piecewise square-law model\nID = if(\n  VG <= VTH,\n  0,\n  if(\n    VD < VG - VTH,\n    K * ((VG - VTH) * VD - VD^2 / 2)\n      * (1 + LAMBDA * VD),\n    K / 2 * (VG - VTH)^2\n      * (1 + LAMBDA * VD)\n  )\n);\nVOV = VG - VTH;',
    variables: [unknown('VD', 1.65), unknown('ID', .0005), parameter('VG', 1.5, 0, 3.3, .01), parameter('VDD', 3.3, 1, 5, .01), parameter('RD', 2200, 100, 10000, 100), parameter('VTH', .7, .1, 1.5, .01), parameter('K', .001, .0001, .005, .0001), parameter('LAMBDA', .02, 0, .1, .001)],
    axes: { x: 'VG', y: 'VD' }, regions: [] },
  { ...base, name: 'CMOS inverter', description: 'Matched square-law NMOS and PMOS with channel-length modulation.',
    equations: '# NMOS and PMOS currents balance at the output\nIN = if(VIN <= VTN, 0, if(VOUT < VIN - VTN, KN * ((VIN - VTN) * VOUT - VOUT^2 / 2) * (1 + LAMBDA * VOUT), KN / 2 * (VIN - VTN)^2 * (1 + LAMBDA * VOUT)));\nIP = if(VDD - VIN <= VTP, 0, if(VDD - VOUT < VDD - VIN - VTP, KP * ((VDD - VIN - VTP) * (VDD - VOUT) - (VDD - VOUT)^2 / 2) * (1 + LAMBDA * (VDD - VOUT)), KP / 2 * (VDD - VIN - VTP)^2 * (1 + LAMBDA * (VDD - VOUT))));\nIN = IP;',
    variables: [unknown('VOUT', 1.65), unknown('IN', .0001), unknown('IP', .0001), parameter('VIN', 1.5, 0, 3.3, .01), parameter('VDD', 3.3, 1.8, 5, .01), parameter('VTN', .7, .2, 1, .01), parameter('VTP', .7, .2, 1, .01), parameter('KN', .001, .0001, .004, .0001), parameter('KP', .001, .0001, .004, .0001), parameter('LAMBDA', .04, .001, .1, .001)],
    sweep: { ...base.sweep, parameter: 'VIN' }, axes: { x: 'VIN', y: 'VOUT' }, regions: [] },
  { ...base, name: 'Cubic · multiple roots', description: 'Explore the three real branches of x³ − x = p and their folds.', equations: 'x^3 - x = p;', variables: [unknown('x', .8, -2, 2), parameter('p', 0, -.6, .6, .005)], sweep: { ...base.sweep, parameter: 'p', min: -.6, max: .6, points: 161 }, axes: { x: 'p', y: 'x' }, regions: [] },
];
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export function validateImport(data: unknown): Configuration {
  if (!data || typeof data !== 'object') throw new Error('Expected a configuration object.');
  const c: Configuration = { ...(data as Configuration), regions: [] };
  if (typeof c.name !== 'string' || typeof c.description !== 'string' || typeof c.equations !== 'string' || typeof c.constraints !== 'string' || !Array.isArray(c.variables) || !Array.isArray(c.regions) || !c.sweep || !c.axes || !c.solver) throw new Error('Configuration is missing required fields. Export an example for the JSON format.');
  if (!c.variables.every(v => v && typeof v.name === 'string' && ['unknown', 'parameter', 'derived'].includes(v.kind) && typeof v.value === 'number')) throw new Error('Invalid variable definitions.');
  if (c.variables.length > 100 || c.equations.length > 50000 || c.regions.length > 50) throw new Error('Configuration exceeds supported size.');
  if (typeof c.axes.x !== 'string' || typeof c.axes.y !== 'string' || !['free', 'constrained'].includes(c.sweep.mode) || !c.regions.every(r => typeof r.name === 'string' && typeof r.condition === 'string' && typeof r.color === 'string')) throw new Error('Invalid axes, sweep mode, or region definitions.');
  const validDimension = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const dimension = value as Record<string, unknown>;
    return typeof dimension.parameter === 'string' && typeof dimension.logarithmic === 'boolean'
      && [dimension.min, dimension.max, dimension.points].every(field => typeof field === 'number' && Number.isFinite(field))
      && [dimension.step, dimension.startAt].every(field => field === undefined || (typeof field === 'number' && Number.isFinite(field)));
  };
  if (c.sweep.secondary !== undefined && !validDimension(c.sweep.secondary)) throw new Error('Invalid second sweep settings.');
  const additional = c.sweep.additional;
  if (additional !== undefined && (!Array.isArray(additional) || !Array.from(additional).every(validDimension))) throw new Error('Invalid additional sweep settings.');
  if ((additional?.length ?? 0) + (c.sweep.secondary ? 1 : 0) > 100) throw new Error('Configuration exceeds supported sweep dimensions.');
  if (c.documents !== undefined) validateDocuments(c.documents);
  const imported = clone(c); migrateUnknownBounds(imported); migrateParameterSweepSettings(imported); migrateEquationInputs(imported);
  if (imported.documents) {
    try { return compileDocuments(imported, imported.documents); }
    catch { /* Preserve invalid source drafts with their last accepted inputs. */ }
  }
  return imported;
}

export const starter: Configuration = {
  ...clone(base), name: 'Equation workspace', description: '',
  equations: 'y = a*x + b;',
  variables: [unknown('y', 1), parameter('x', 0, -5, 5, .1), parameter('a', 1, -5, 5, .1), parameter('b', 0, -5, 5, .1)],
  axes: { x: 'x', y: 'y' }, sweep: { ...base.sweep, parameter: 'x', min: -5, max: 5 }, regions: [],
};
