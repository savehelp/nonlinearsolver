import { compile, lines, residual } from './expression';
import { equationProgram } from './equations';
import type { Configuration, SecondarySweep } from './types';
import { plotCurves } from './axes';
import { inferVariables } from './inference';

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
  let definitions = config.variables;
  if (config.sweep.mode === 'constrained') try { definitions = inferVariables(config); } catch { /* Keep invalid drafts editable. */ }
  const candidates = definitions.filter(v => v.kind === (config.sweep.mode === 'free' ? 'parameter' : 'unknown'));
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

/** Dependencies come only from the user's math and plot expressions. */
export function usedVariables(config: Configuration): Set<string> {
  const program = equationProgram(config.equations);
  const used = new Set([
    ...program.equations.flatMap(source => residual(source).variables),
    ...program.conditions.flatMap(source => compile(source).variables),
    ...lines(config.constraints).flatMap(source => compile(source).variables),
    ...compile(config.axes.x).variables, ...plotCurves(config.axes).flatMap(curve => [curve.x, curve.y].flatMap(expression => compile(expression).variables)),
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
