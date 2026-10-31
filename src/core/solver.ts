import { compile, lines, residual, type Expression } from './expression';
import type { Complex, Configuration, Root, Scope, Variable, SweepResult, Branch, Point } from './types';
import { usedVariables } from './variables';
import { configurationCurves, plotCurves } from './axes';
import { coordinateExpression } from './coordinates';
import { prepareComplex } from './complexSolver';
import { applyValidityBounds } from './constraints';
import { parameterSweepPlan } from './sweepPlan';
import { MAX_PARAMETER_SAMPLES } from './sweepLimits';
import { assignmentPlan, evaluateAssignments, substitutionPlan } from './assignments';
import { equationProgram } from './equations';
import { inferVariables } from './inference';
import { affineRoot, affineSubstitutions } from './preprocessing';
import { formatSampleCount } from './sweepCounts';
import type { SampleLookup } from './sampleReuse';
const norm = (a: number[]) => Math.max(0, ...a.map(Math.abs));
interface Evaluation { values: Scope; complexValues?: Record<string, Complex>; residuals: number[] }
export interface System { unknowns: Variable[]; allUnknowns?: Variable[]; equations: string[]; evaluate: (x: number[]) => Evaluation; direct?: () => Evaluation; directContinuous?: boolean; valid: (values: Scope) => boolean; region: (values: Scope) => string }
export function prepare(config: Configuration, parameter?: number): System {
  if (config.solver.complex) return prepareComplex(config, parameter);
  if (!config.axes.x.trim() || !config.axes.y.trim()) throw new Error('Add set_time_axis parameter and plot unknown commands.');
  const program = equationProgram(config.equations);
  const used = usedVariables(config);
  const definitions = inferVariables(config, program);
  const names = new Set<string>();
  for (const v of definitions.filter(v => used.has(v.name))) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(v.name) || ['pi', 'e', 'true', 'false'].includes(v.name)) throw new Error(`Invalid or reserved variable name “${v.name}”.`);
    if (names.has(v.name)) throw new Error(`Variable “${v.name}” is defined twice.`); names.add(v.name);
    if (!Number.isFinite(v.value) || (v.min !== undefined && !Number.isFinite(v.min)) || (v.max !== undefined && !Number.isFinite(v.max))) throw new Error(`Values and bounds for ${v.name} must be finite.`);
    if (v.min !== undefined && v.max !== undefined && v.min >= v.max) throw new Error(`${v.name}: minimum must be less than maximum.`);
  }
  const variables = definitions.filter(v => used.has(v.name)).map(v => ({ ...v }));
  if (config.sweep.mode === 'constrained') {
    const imposed = variables.find(v => v.name === config.sweep.parameter), released = variables.find(v => v.name === config.sweep.release);
    if (imposed?.kind !== 'unknown' || released?.kind !== 'parameter') throw new Error('A constrained sweep imposes an unknown and releases one fixed parameter.');
    imposed.kind = 'parameter'; released.kind = 'unknown';
  } else if (variables.find(v => v.name === config.sweep.parameter)?.kind !== 'parameter') throw new Error(config.sweep.parameter ? `The selected sweep variable “${config.sweep.parameter}” is not an existing parameter. Add sweep after its value, step, minimum and maximum in Parameters.` : 'Select a sweep by adding sweep after a parameter’s value, step, minimum and maximum in Parameters.');
  const allUnknowns = variables.filter(v => v.kind === 'unknown');
  const originalEquations = program.equations, originalExpressions = originalEquations.map(residual);
  if (allUnknowns.length !== originalExpressions.length) throw new Error(`${originalExpressions.length < allUnknowns.length ? 'Underdetermined' : 'Overdetermined'} system: ${originalExpressions.length} equations for ${allUnknowns.length} unknowns (${allUnknowns.map(variable => variable.name).join(', ')}). Declare intended fixed inputs with parameter name value, or add/remove equations to match the unknowns.`);
  if (!allUnknowns.length && !variables.some(variable => variable.kind === 'derived')) throw new Error('Define an unknown or an assignment in Equations.');
  const derived = variables.filter(v => v.kind === 'derived').map(v => ({ name: v.name, source: v.expression || '', expression: compile(v.expression || '') }));
  const conditionSources = [...program.conditions, ...lines(config.constraints)];
  const constraints = conditionSources.map(compile);
  const check = (e: Expression) => { for (const name of e.variables) if (!names.has(name)) throw new Error(`“${name}” is not defined. Add it under Unknowns or Parameters.`); };
  [...originalExpressions, ...constraints, ...derived.map(d => d.expression), compile(config.axes.x), ...plotCurves(config.axes).flatMap(curve => [compile(curve.x), compile(curve.y)])].forEach(check);
  const fixed: Scope = Object.create(null);
  variables.filter(v => v.kind === 'parameter').forEach(v => fixed[v.name] = v.name === config.sweep.parameter && parameter !== undefined ? parameter : v.value);
  applyValidityBounds(allUnknowns, conditionSources.join('\n'), fixed);
  const assignments = assignmentPlan(originalEquations, allUnknowns.map(variable => variable.name), derived, fixed);
  const linearCandidate = !assignments && !derived.length ? affineRoot(originalExpressions, allUnknowns.map(variable => variable.name), fixed, config.solver.tolerance) : null;
  // A rounded direct root just outside an inclusive endpoint gets the existing
  // projected numerical path, rather than losing an otherwise valid endpoint.
  const linearValues = linearCandidate && allUnknowns.every(variable => linearCandidate[variable.name] >= (variable.min ?? -Infinity) && linearCandidate[variable.name] <= (variable.max ?? Infinity)) ? linearCandidate : null;
  const bounded = new Set(allUnknowns.filter(variable => variable.min !== undefined || variable.max !== undefined).map(variable => variable.name));
  const existing = assignments || linearValues ? null : substitutionPlan(originalEquations, allUnknowns.map(variable => variable.name), derived, fixed, bounded);
  const isolated = !assignments && !linearValues && !derived.length ? affineSubstitutions(originalEquations, originalExpressions, allUnknowns.map(variable => variable.name), fixed, bounded) : null;
  // If eliminating every unknown failed the direct residual/conditioning
  // checks, retain Newton rather than retrying that candidate as a reduction.
  const useIsolation = !!isolated && isolated.names.size < allUnknowns.length && isolated.names.size > (existing?.names.size ?? 0);
  const substitutions = useIsolation ? isolated : existing;
  const unknowns = substitutions ? allUnknowns.filter(variable => !substitutions.names.has(variable.name)) : allUnknowns;
  const equations = substitutions?.equations ?? originalEquations;
  const expressions = equations === originalEquations ? originalExpressions : equations.map(source => originalExpressions[originalEquations.indexOf(source)]);
  const constantNames = new Set(Object.keys(fixed));
  const constantAssignments = substitutions?.ordered.filter(assignment => {
    if (!assignment.expression.variables.every(name => constantNames.has(name))) return false;
    constantNames.add(assignment.name); return true;
  }) ?? [];
  const dynamicAssignments = substitutions?.ordered.filter(assignment => !constantNames.has(assignment.name)) ?? [];
  let constants: Scope | undefined;
  function evaluate(x: number[]) {
    const values: Scope = Object.assign(Object.create(null), fixed); unknowns.forEach((v, i) => values[v.name] = x[i]);
    if (substitutions) {
      if (substitutions.circular) throw new Error('Derived expressions contain a circular dependency.');
      if (!constants) {
        const calculated: Scope = Object.assign(Object.create(null), fixed);
        for (const assignment of constantAssignments) calculated[assignment.name] = assignment.expression.evaluate(calculated);
        constants = calculated;
      }
      Object.assign(values, constants);
      for (const assignment of dynamicAssignments) values[assignment.name] = assignment.expression.evaluate(values);
    } else {
      let pending = [...derived];
      while (pending.length) {
        const ready = pending.filter(d => d.expression.variables.every(n => Object.hasOwn(values, n)));
        if (!ready.length) throw new Error('Derived expressions contain a circular dependency.');
        ready.forEach(d => values[d.name] = d.expression.evaluate(values)); pending = pending.filter(d => !ready.includes(d));
      }
    }
    return { values, residuals: expressions.map(e => e.evaluate(values)) };
  }
  return {
    unknowns, allUnknowns, equations, evaluate,
    ...(assignments ? { direct: () => { const values = evaluateAssignments(assignments, fixed); return { values, residuals: expressions.map(expression => expression.evaluate(values)) }; }, directContinuous: assignments.continuous } : {}),
    ...(linearValues ? { direct: () => { const values: Scope = Object.assign(Object.create(null), linearValues); return { values, residuals: originalExpressions.map(expression => expression.evaluate(values)) }; }, directContinuous: originalEquations.every(source => !/\b(?:if|floor|ceil|sign)\s*\(|[?:<>=!&|]/.test(source.replace(/(?<![<>=!])=(?!=)/g, ''))) } : {}),
    valid: values => {
      if (useIsolation && !isolated!.validate(values, config.solver.tolerance)) throw new Error('Algebraic reduction did not satisfy the original equations.');
      return constraints.every(c => Boolean(c.evaluate(values)));
    }, region: () => '',
  };
}
function linearSolve(matrix: number[][], vector: number[]): number[] | null {
  const a = matrix.map((row, i) => [...row, vector[i]]), n = vector.length;
  for (let k = 0; k < n; k++) {
    let pivot = k; for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    if (Math.abs(a[pivot][k]) < 1e-20) return null;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    for (let i = k + 1; i < n; i++) { const f = a[i][k] / a[k][k]; for (let j = k; j <= n; j++) a[i][j] -= f * a[k][j]; }
  }
  const x = Array(n).fill(0); for (let i = n - 1; i >= 0; i--) { let v = a[i][n]; for (let j = i + 1; j < n; j++) v -= a[i][j] * x[j]; x[i] = v / a[i][i]; } return x;
}
export function jacobian(system: System, x: number[]): number[][] {
  const base = system.evaluate(x).residuals; const j = base.map(() => Array(x.length).fill(0));
  x.forEach((value, k) => {
    const v = system.unknowns[k], scale = variableScale(v), h = 1e-5 * Math.max(Math.abs(value), scale * 1e-3, 1e-10);
    const plus = [...x], minus = [...x]; plus[k] += h; minus[k] -= h;
    let a: number[] | undefined, b: number[] | undefined;
    try { a = system.evaluate(plus).residuals; } catch { /* One-sided derivative at a domain boundary. */ }
    try { b = system.evaluate(minus).residuals; } catch { /* One-sided derivative at a domain boundary. */ }
    if (!a && !b) throw new Error('Invalid evaluations around the numerical Jacobian.');
    base.forEach((f, i) => j[i][k] = a && b ? (a[i] - b[i]) / (2 * h) : a ? (a[i] - f) / h : (f - b![i]) / h);
  }); return j;
}
export function variableScale(v: Variable): number {
  if (v.scale !== undefined && Number.isFinite(v.scale) && v.scale > 0) return v.scale;
  const scale = Math.max(Math.abs(v.value), v.min !== undefined && v.max !== undefined ? (v.max - v.min) / 2 : 0);
  return scale === 0 ? 1 : Math.max(scale, 1e-6);
}
export function solve(system: System, guess: number[], options: Configuration['solver'], includeJacobian = true): Root {
  const checkBounds = (values: Scope) => {
    const outside = (system.allUnknowns ?? system.unknowns).flatMap(variable => {
      const value = values[variable.name];
      return value < (variable.min ?? -Infinity) ? [`${variable.name} is at its minimum (${variable.min}); the equations require ${value}`]
        : value > (variable.max ?? Infinity) ? [`${variable.name} is at its maximum (${variable.max}); the equations require ${value}`] : [];
    });
    if (outside.length) throw new Error(`No solution within the configured bounds: ${outside.join('; ')}. Check validity conditions in Equations.`);
  };
  if (system.direct) {
    const state = system.direct();
    checkBounds(state.values);
    if (!system.valid(state.values)) throw new Error('Candidate root violates an inequality or branch validity condition.');
    return { ...state, norm: norm(state.residuals), iterations: 0, jacobian: includeJacobian ? jacobian(system, system.unknowns.map(variable => state.values[variable.name])) : [], region: system.region(state.values) };
  }
  const scales = system.unknowns.map(variableScale);
  if (system.allUnknowns && guess.length !== system.unknowns.length) {
    const supplied = new Map(system.allUnknowns.map((variable, index) => [variable.name, guess[index] ?? variable.value]));
    guess = system.unknowns.map(variable => supplied.get(variable.name)!);
  }
  const bound = (x: number[]) => x.map((v, i) => Math.min(system.unknowns[i].max ?? Infinity, Math.max(system.unknowns[i].min ?? -Infinity, v)));
  let x = bound(guess), state = system.evaluate(x), lastError = 'Nonconvergence: iteration limit reached.';
  const initialJ = jacobian(system, x);
  const rowScale = initialJ.map((row, i) => Math.max(Math.abs(state.residuals[i]), ...row.map((d, k) => Math.abs(d * scales[k])), 1e-12));
  const merit = (f: number[]) => f.reduce((s, v, i) => s + (v / rowScale[i]) ** 2, 0);
  const acceptRoot = (iteration: number, derivatives?: number[][]): Root => {
    checkBounds(state.values);
    if (!system.valid(state.values)) throw new Error('Candidate root violates an inequality or branch validity condition.');
    return { ...state, norm: norm(state.residuals), iterations: iteration, jacobian: includeJacobian ? derivatives ?? jacobian(system, x) : [], region: system.region(state.values) };
  };
  let damping = 1e-8;
  for (let iteration = 0; iteration <= options.iterations; iteration++) {
    const residualNorm = norm(state.residuals);
    if (residualNorm === 0) return acceptRoot(iteration);
    const j = iteration === 0 ? initialJ : jacobian(system, x);
    const a = j.map((row, i) => row.map((d, k) => d * scales[k] / rowScale[i]));
    const f = state.residuals.map((v, i) => v / rowScale[i]);
    const newtonStep = linearSolve(a, f.map(v => -v));
    // A small residual alone can leave large variable errors near a flat root.
    // Check the full Newton correction, before damping or line-search clipping;
    // exact roots remain valid even when their Jacobian is singular.
    const smallCorrection = newtonStep?.every((step, i) => Number.isFinite(step) && Math.abs(step) <= options.tolerance * Math.max(1, Math.abs(x[i]) / scales[i]));
    if (norm(f) <= options.tolerance && residualNorm <= options.tolerance * Math.max(1, norm(rowScale)) && smallCorrection) return acceptRoot(iteration, j);
    let accepted = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      let step: number[] | null = attempt === 0 ? newtonStep : null;
      if (!step) {
        const normal = scales.map((_, k) => scales.map((__, l) => a.reduce((sum, row) => sum + row[k] * row[l], 0) + (k === l ? damping : 0)));
        const rhs = scales.map((_, k) => -a.reduce((sum, row, i) => sum + row[k] * f[i], 0)); step = linearSolve(normal, rhs);
      }
      if (step) for (let alpha = 1; alpha >= 1 / 1024; alpha /= 2) {
        const next = bound(x.map((v, i) => v + alpha * step![i] * scales[i]));
        try { const candidate = system.evaluate(next); if (merit(candidate.residuals) < merit(state.residuals)) { x = next; state = candidate; accepted = true; damping = Math.max(1e-12, damping / 10); break; } } catch { lastError = 'Invalid evaluation: check function domains and initial guesses.'; }
      }
      if (accepted) break; damping *= 10;
    }
    if (!accepted) {
      const activeBounds = system.unknowns.flatMap((v, i) => x[i] === v.min ? [`${v.name} is at its minimum (${v.min})`] : x[i] === v.max ? [`${v.name} is at its maximum (${v.max})`] : []);
      if (activeBounds.length) throw new Error(`No solution within the configured bounds: ${activeBounds.join('; ')}. Check validity conditions in Equations if they are not intended for your equations.`);
      throw new Error(`${lastError} A singular Jacobian or discontinuity may prevent progress.`);
    }
  }
  const activeBounds = system.unknowns.flatMap((v, i) => x[i] === v.min ? [`${v.name} is at its minimum (${v.min})`] : x[i] === v.max ? [`${v.name} is at its maximum (${v.max})`] : []);
  throw new Error(activeBounds.length ? `${lastError} Check the configured bounds: ${activeBounds.join('; ')}. Clear or adjust them in Equations if unintended.` : lastError);
}
const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
function halton(index: number, base: number) { let value = 0, f = 1; while (index) { f /= base; value += f * (index % base); index = Math.floor(index / base); } return value; }
export function distance(a: Scope, b: Scope, variables: Variable[]): number { return Math.sqrt(variables.reduce((s, v) => s + ((a[v.name] - b[v.name]) / variableScale(v)) ** 2, 0)); }
export function roots(system: System, options: Configuration['solver'], seeds: number[][] = [], includeJacobian = true): { roots: Root[]; error: string } {
  if (system.direct) {
    try { return { roots: [solve(system, [], options, includeJacobian)], error: '' }; }
    catch (error) { return { roots: [], error: error instanceof Error ? error.message : 'Calculation failed.' }; }
  }
  const guesses = [system.unknowns.map(v => v.value), ...seeds];
  for (let n = 1; n < options.starts; n++) guesses.push(system.unknowns.map((v, i) => { const h = halton(n, primes[i % primes.length]); return v.min !== undefined && v.max !== undefined ? v.min + h * (v.max - v.min) : v.value + (h * 2 - 1) * variableScale(v) * 8; }));
  const found: Root[] = []; let error = '';
  for (const guess of guesses) { try { const root = solve(system, guess, options, includeJacobian); if (!found.some(r => distance(r.values, root.values, system.unknowns) < Math.max(1e-5, options.tolerance * 100))) found.push(root); } catch (e) { const message = e instanceof Error ? e.message : 'Calculation failed.'; if (message.includes('configured bounds') || !error.includes('configured bounds')) error = message; } }
  return { roots: found, error };
}
export interface SweepStep { result: SweepResult; completed: number }
export interface SweepSample { points: Point[]; failures: SweepResult['failures'] }
/** Progress borrows the growing result. Consumers must copy new data before resuming. */
export function* sweepSteps(config: Configuration, intervalMs = 200, onSample?: (result: SweepResult, sample: SweepSample) => void, reuse?: SampleLookup): Generator<SweepStep, SweepStep> {
  const start = performance.now(), s = config.sweep;
  const centered = Object.hasOwn(s, 'step');
  let nextProgress = start + intervalMs;
  if (![config.solver.tolerance, config.solver.starts, config.solver.iterations, ...(!centered ? [s.min, s.max, s.points] : [])].every(Number.isFinite)) throw new Error('Sweep and solver settings must be finite numbers.');
  if (!centered && (s.min >= s.max || s.points < 2 || s.points > MAX_PARAMETER_SAMPLES || !Number.isInteger(s.points))) throw new Error(`Use an increasing sweep range and 2–${MAX_PARAMETER_SAMPLES.toLocaleString('en-US')} integer points; requested ${formatSampleCount(s.points)} points.`);
  if (!centered && s.logarithmic && s.min <= 0) throw new Error('Logarithmic sweeps require positive limits.');
  if (config.solver.tolerance <= 0 || config.solver.tolerance > .1 || config.solver.iterations < 1 || config.solver.iterations > 1000 || config.solver.starts < 1 || config.solver.starts > 64) throw new Error('Use tolerance in (0, 0.1], 1–1000 iterations, and 1–64 starts.');
  const selected = config.variables.find(variable => variable.name === s.parameter);
  const plan = centered ? parameterSweepPlan({ name: s.parameter, kind: 'parameter', value: s.startAt ?? selected?.value ?? s.min, min: s.min, max: s.max, step: s.step }) : null;
  const total = plan?.values.length ?? s.points;
  const firstSystem = prepare(config, plan ? plan.values[plan.startIndex] : s.min), curves = configurationCurves(config);
  const xCompiled = curves.map(curve => coordinateExpression(curve.x, config.solver.complex)), yCompiled = curves.map(curve => coordinateExpression(curve.y, config.solver.complex));
  const result: SweepResult = { branches: [], failures: [], solved: 0, total, elapsed: 0, unknowns: firstSystem.unknowns.map(v => v.name), equations: firstSystem.equations, computed: 0, reused: 0 };
  type Frontier = { branch: Branch; root: Root }[];
  let previous: Frontier = [], lower: Frontier = [], upper: Frontier = [], nextId = 1;
  for (let completed = 0; completed < total; completed++) {
    const i = plan?.order[completed] ?? completed;
    const atCenter = !!plan && completed === 0, toLower = !!plan && i < plan.startIndex;
    if (plan) previous = atCenter ? [] : toLower ? lower : upper;
    const samplePoints: Point[] | undefined = onSample ? [] : undefined, firstFailure = result.failures.length;
    const t = total === 1 ? 0 : i / (total - 1), parameter = plan ? plan.values[i] : s.logarithmic ? s.min * (s.max / s.min) ** t : s.min + (s.max - s.min) * t;
    // Dense Jacobians are computed only when inspecting a point, rather than
    // retaining an unknown-count-squared matrix at every stored sample.
    const system = prepare(config, parameter), cached = reuse?.(parameter);
    const found = cached ?? roots(system, config.solver, previous.map(p => system.unknowns.map(v => p.root.values[v.name])), false);
    if (cached) result.reused!++; else result.computed!++;
    const available = new Set(previous); const current: typeof previous = [];
    if (!found.roots.length) result.failures.push({ index: i, parameter, reason: found.error || 'No root found.' }); else result.solved++;
    // Continue from the adjacent point on the same side of the starting sample.
    // A failed point breaks only that side; the other frontier remains usable.
    const pairs = found.roots.flatMap((root, r) => previous.map(p => ({ r, p, d: distance(root.values, p.root.values, system.unknowns) }))).sort((a, b) => a.d - b.d);
    const matches = new Map<number, Branch>();
    for (const pair of pairs) if ((system.directContinuous || pair.d < .65) && available.has(pair.p) && !matches.has(pair.r)) { matches.set(pair.r, pair.p.branch); available.delete(pair.p); }
    found.roots.forEach((root, r) => {
      try {
        const branch = matches.get(r) ?? { id: nextId++, points: [] };
        const xs = xCompiled.map((expression, series) => {
          try { return expression.evaluate(root.values, root.complexValues); }
          catch (error) { result.failures.push({ index: i, parameter, reason: `X expression “${curves[series].x}”: ${(error as Error).message}` }); return null; }
        });
        const ys = yCompiled.map((expression, series) => {
          try { return expression.evaluate(root.values, root.complexValues); }
          catch (error) { result.failures.push({ index: i, parameter, reason: `Y expression “${curves[series].y}”: ${(error as Error).message}` }); return null; }
        });
        if (ys.every((value, series) => value === null || xs[series] === null)) return;
        const point: Point = { ...root, x: xs[0] ?? NaN, y: ys[0] ?? NaN, ys, ...(config.axes.curves ? { xs } : {}), parameter, index: i, branch: branch.id };
        if (!branch.points.length) result.branches.push(branch);
        if (branch.points.length && i < branch.points[0].index) branch.points.unshift(point); else branch.points.push(point);
        current.push({ branch, root });
        samplePoints?.push(point);
      } catch (error) { result.failures.push({ index: i, parameter, reason: `Axis evaluation: ${(error as Error).message}` }); }
    });
    if (plan) {
      if (atCenter) { lower = current; upper = current; }
      else if (toLower) lower = current;
      else upper = current;
    } else previous = current;
    if (onSample) onSample(result, { points: samplePoints!, failures: result.failures.slice(firstFailure) });
    if (intervalMs !== Infinity && completed + 1 < total && performance.now() >= nextProgress) {
      result.elapsed = performance.now() - start;
      yield { result, completed: completed + 1 };
      nextProgress = performance.now() + intervalMs;
    }
  }
  if (!result.branches.length) throw new Error(`No points could be plotted. ${result.failures[0]?.reason ?? 'No valid roots were found.'}`);
  result.elapsed = performance.now() - start; return { result, completed: total };
}
export function sweep(config: Configuration): SweepResult {
  const steps = sweepSteps(config, Infinity);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value.result;
}
