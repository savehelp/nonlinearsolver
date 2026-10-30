import { jacobian, prepare } from './solver';
import type { Configuration, Point } from './types';

/** Sweep samples retain compact diagnostics. Inspection prepares the actual
 * point so parameter-dependent elimination cannot leave stale Jacobian labels. */
export function withPointJacobian(config: Configuration, point: Point): Point {
  if (point.diagnosticUnknowns && point.diagnosticEquations && point.jacobian.length === point.diagnosticEquations.length
    && point.jacobian.every(row => row.length === point.diagnosticUnknowns!.length)) return point;
  const snapshot = { ...config, variables: config.variables.map(variable => variable.kind === 'parameter' && Object.hasOwn(point.values, variable.name)
    ? { ...variable, value: point.values[variable.name] } : variable) };
  const system = prepare(snapshot, point.parameter);
  const values = system.unknowns.map(variable => point.values[variable.name]);
  if (!values.every(Number.isFinite)) throw new Error('This point is missing values needed for its Jacobian.');
  const residuals = system.evaluate(values).residuals;
  const existingJacobian = point.jacobian.length === system.equations.length && point.jacobian.every(row => row.length === system.unknowns.length);
  return {
    ...point, residuals, norm: Math.max(0, ...residuals.map(Math.abs)),
    jacobian: existingJacobian ? point.jacobian : jacobian(system, values),
    diagnosticUnknowns: system.unknowns.map(variable => variable.name), diagnosticEquations: [...system.equations],
  };
}
