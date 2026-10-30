import { equationAssignment, equationProgram } from './equations';
import { lines } from './expression';
import { prepare } from './solver';
import type { Configuration } from './types';

export interface ModelDiagnostics {
  declaredUnknowns: number;
  parameters: number;
  declaredDerived: number;
  /** Names introduced by assignment statements, before algebraic reduction. */
  inferredVariables: number | null;
  equations: number | null;
  conditions: number | null;
  tabs: number;
  activeUnknowns?: number;
  numericalUnknowns?: number;
  direct?: boolean;
  preparationSkipped?: boolean;
  issue?: string;
}

/** Inspect one configuration at its sweep start, without solving or reading
 * cached points. Callers should memoize this when displaying diagnostics.
 * Counts remain useful when preparation fails; null means statement syntax
 * prevents a reliable count. Numerical dimensions may vary across a sweep. */
export function modelDiagnostics(config: Configuration): ModelDiagnostics {
  const summary: ModelDiagnostics = {
    declaredUnknowns: config.variables.filter(variable => variable.kind === 'unknown').length,
    parameters: config.variables.filter(variable => variable.kind === 'parameter').length,
    declaredDerived: config.variables.filter(variable => variable.kind === 'derived').length,
    inferredVariables: null,
    equations: null,
    conditions: null,
    tabs: config.documents?.length ?? 0,
  };
  try {
    const program = equationProgram(config.equations);
    const declared = new Set(config.variables.map(variable => variable.name));
    const inferred = new Set<string>();
    for (const equation of program.equations) {
      const assignment = equationAssignment(equation);
      if (assignment && !declared.has(assignment.name) && !['pi', 'e', 'true', 'false'].includes(assignment.name)) inferred.add(assignment.name);
    }
    summary.inferredVariables = inferred.size;
    summary.equations = program.equations.length;
    summary.conditions = program.conditions.length + lines(config.constraints).length;
    // Source assignments can introduce more names than the declaration limit.
    // Keep opening diagnostics cheap; large numerical systems stay in the worker.
    if (summary.declaredUnknowns + inferred.size > 100) {
      summary.preparationSkipped = true;
      return summary;
    }
    const selected = config.variables.find(variable => variable.name === config.sweep.parameter);
    const system = prepare(config, config.sweep.startAt ?? (config.sweep.mode === 'constrained' ? config.sweep.min : selected?.value));
    summary.activeUnknowns = (system.allUnknowns ?? system.unknowns).length;
    summary.numericalUnknowns = system.direct ? 0 : system.unknowns.length;
    summary.direct = Boolean(system.direct);
  } catch (error) {
    summary.issue = error instanceof Error ? error.message : 'Unable to prepare this model.';
  }
  return summary;
}
