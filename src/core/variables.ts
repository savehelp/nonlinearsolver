import { compile, lines, residual } from './expression';
import { equationProgram } from './equations';
import type { Configuration, SecondarySweep, Variable } from './types';
import { yExpressions } from './axes';

/** The first slice dimension keeps its original saved-workspace field. */
export function sliceSweeps(config: Configuration): SecondarySweep[] {
  return [...(config.sweep.secondary ? [config.sweep.secondary] : []), ...(config.sweep.additional ?? [])];
}

export function setSliceSweeps(config: Configuration, dimensions: SecondarySweep[]): void {
  if (dimensions.length) config.sweep.secondary = dimensions[0];
  else delete config.sweep.secondary;
  if (dimensions.length > 1) config.sweep.additional = dimensions.slice(1);
  else delete config.sweep.additional;
}

export function reconcileSweep(config: Configuration, selectSole = true): void {
  const candidates = config.variables.filter(v => v.kind === (config.sweep.mode === 'free' ? 'parameter' : 'unknown'));
  if (!candidates.some(v => v.name === config.sweep.parameter)) config.sweep.parameter = selectSole && candidates.length === 1 ? candidates[0].name : '';
  const released = config.variables.filter(v => v.kind === 'parameter');
  if (config.sweep.mode === 'constrained' && !released.some(v => v.name === config.sweep.release)) config.sweep.release = released.length === 1 ? released[0].name : '';
  const selected = new Set([config.sweep.parameter, ...(config.sweep.mode === 'constrained' ? [config.sweep.release] : [])]);
  for (const dimension of sliceSweeps(config)) {
    if (selected.has(dimension.parameter) || !released.some(variable => variable.name === dimension.parameter)) dimension.parameter = '';
    else selected.add(dimension.parameter);
  }
}

export function parameterSweepRole(config: Configuration, name: string): 'primary' | 'secondary' | null {
  const variable = config.variables.find(variable => variable.name === name);
  if (variable?.kind !== 'parameter' || (config.sweep.mode === 'constrained' && name === config.sweep.release)) return null;
  if (config.sweep.mode === 'free' && name === config.sweep.parameter) return 'primary';
  return sliceSweeps(config).some(dimension => dimension.parameter === name) ? 'secondary' : null;
}

function sliderSweepRange(variable: Variable): { min: number; max: number } {
  const min = variable.min ?? Math.min(variable.value, 0);
  const candidate = variable.max ?? Math.max(10, variable.value * 2);
  return { min, max: candidate > min ? candidate : min + Math.max(1, Math.abs(min)) };
}

/** Parameter checkboxes select one main sweep and any number of slice sweeps.
 * Removing the main choice promotes the existing slices without changing axes. */
export function toggleParameterSweep(config: Configuration, name: string, enabled: boolean): void {
  const variable = config.variables.find(variable => variable.name === name);
  if (variable?.kind !== 'parameter' || (config.sweep.mode === 'constrained' && name === config.sweep.release)) return;
  const role = parameterSweepRole(config, name);
  const dimensions = sliceSweeps(config);
  const mainExists = config.variables.some(variable => variable.kind === 'parameter' && variable.name === config.sweep.parameter);
  if (enabled) {
    if (config.sweep.mode === 'free' && !mainExists) {
      delete config.sweep.step; delete config.sweep.startAt;
      Object.assign(config.sweep, { parameter: name, ...sliderSweepRange(variable), logarithmic: false });
      setSliceSweeps(config, dimensions.filter(dimension => dimension.parameter !== name));
    } else if (!role) {
      const dimension = { parameter: name, ...sliderSweepRange(variable), points: 11, logarithmic: false };
      const empty = dimensions.findIndex(selected => !selected.parameter);
      if (empty >= 0) dimensions[empty] = dimension;
      else dimensions.push(dimension);
      setSliceSweeps(config, dimensions);
    }
  } else if (role === 'secondary') {
    setSliceSweeps(config, dimensions.filter(dimension => dimension.parameter !== name));
  } else if (role === 'primary') {
    const first = dimensions.findIndex(dimension => dimension.parameter);
    if (first >= 0) {
      delete config.sweep.step; delete config.sweep.startAt;
      Object.assign(config.sweep, dimensions[first]);
      setSliceSweeps(config, dimensions.filter((_, index) => index !== first));
    }
  }
  reconcileSweep(config);
}

export function addVariable(config: Configuration, kind: Variable['kind'] = 'unknown'): void {
  let index = 1; const prefix = kind === 'derived' ? 'derived' : 'var';
  while (config.variables.some(v => v.name === `${prefix}${index}`)) index++;
  config.variables.push({ name: `${prefix}${index}`, kind, value: kind === 'derived' ? 0 : 1, ...(kind === 'derived' ? { expression: '0' } : kind === 'parameter' ? { min: -5, max: 5, step: .1 } : {}) });
  reconcileSweep(config);
}

export function updateVariable(config: Configuration, index: number, update: Partial<Variable>, selectSole = true): void {
  const variable = config.variables[index]; if (!variable) return;
  const oldName = variable.name;
  if (update.kind && update.kind !== variable.kind) {
    delete variable.min; delete variable.max; delete variable.step;
    if (update.kind === 'parameter') Object.assign(variable, { min: -5, max: 5, step: .1 });
    if (update.kind === 'derived' && !variable.expression) variable.expression = '0';
  }
  Object.assign(variable, update);
  if (update.name !== undefined && update.name !== oldName) {
    if (config.sweep.parameter === oldName) config.sweep.parameter = update.name;
    if (config.sweep.release === oldName) config.sweep.release = update.name;
    for (const dimension of sliceSweeps(config)) if (dimension.parameter === oldName) dimension.parameter = update.name;
  }
  reconcileSweep(config, selectSole);
}

export function deleteVariable(config: Configuration, index: number): void {
  config.variables.splice(index, 1); reconcileSweep(config);
}

/** Dependencies come only from the user's math and plot expressions. */
export function usedVariables(config: Configuration): Set<string> {
  const program = equationProgram(config.equations);
  const used = new Set([
    ...program.equations.flatMap(source => residual(source).variables),
    ...program.conditions.flatMap(source => compile(source).variables),
    ...lines(config.constraints).flatMap(source => compile(source).variables),
    ...compile(config.axes.x).variables, ...yExpressions(config.axes.y).flatMap(expression => compile(expression).variables),
  ]);
  used.add(config.sweep.parameter);
  if (config.sweep.mode === 'constrained') used.add(config.sweep.release);
  for (const dimension of sliceSweeps(config)) if (dimension.parameter) used.add(dimension.parameter);
  let changed = true;
  while (changed) {
    changed = false;
    for (const variable of config.variables) if (variable.kind === 'derived' && used.has(variable.name)) {
      for (const name of compile(variable.expression || '').variables) if (!used.has(name)) { used.add(name); changed = true; }
    }
  }
  return used;
}

export function activeVariables(config: Configuration): Set<string> {
  try { return usedVariables(config); }
  catch { return new Set(config.variables.map(variable => variable.name)); }
}
