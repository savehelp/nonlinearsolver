import { compile, type Expression } from './expression';
import type { Scope } from './types';
import { equationAssignment } from './equations';

export interface Assignment { name: string; source: string; expression: Expression }
export interface AssignmentPlan { ordered: Assignment[]; continuous: boolean }

/** A complete acyclic assignment system has one root, independent of initial guesses.
 * Recognize only a single unknown identifier on the left of each equality. All
 * other equation forms, duplicate definitions and cycles keep the Newton path. */
export function assignmentPlan(equations: string[], unknowns: string[], derived: Assignment[], fixed: Scope): AssignmentPlan | null {
  const remaining = new Set(unknowns), definitions: Assignment[] = [];
  for (const equation of equations) {
    const equalities = [...equation.matchAll(/(?<![<>=!])=(?!=)/g)];
    if (equalities.length !== 1) return null;
    const at = equalities[0].index!, name = equation.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || !remaining.delete(name)) return null;
    const source = equation.slice(at + 1);
    definitions.push({ name, source, expression: compile(source) });
  }
  if (remaining.size) return null;
  let pending = [...definitions, ...derived];
  const available = new Set(Object.keys(fixed)), ordered: Assignment[] = [];
  while (pending.length) {
    const ready = pending.filter(assignment => assignment.expression.variables.every(name => available.has(name)));
    if (!ready.length) return null;
    for (const assignment of ready) { ordered.push(assignment); available.add(assignment.name); }
    pending = pending.filter(assignment => !ready.includes(assignment));
  }
  // Preserve gap detection for branch switches and step functions. Continuous
  // arithmetic can still have poles between samples; undefined samples break it.
  const continuous = ordered.every(assignment => !/\b(?:if|floor|ceil|sign)\s*\(|[?:<>=!&|]/.test(assignment.source));
  return { ordered, continuous };
}

export function evaluateAssignments(plan: AssignmentPlan, fixed: Scope): Scope {
  const values: Scope = Object.assign(Object.create(null), fixed);
  for (const assignment of plan.ordered) values[assignment.name] = assignment.expression.evaluate(values);
  return values;
}

export interface SubstitutionPlan { names: Set<string>; equations: string[]; ordered: Assignment[]; circular: boolean }

/** Eliminate uniquely assigned variables outside dependency cycles. Remaining
 * numerical variables supply the inputs for this small ordered evaluation plan;
 * expressions are never expanded into exponentially larger expression trees. */
export function substitutionPlan(equations: string[], unknowns: string[], derived: Assignment[], fixed: Scope, bounded = new Set<string>()): SubstitutionPlan {
  const unknownSet = new Set(unknowns), counts = new Map<string, number>();
  const assignments = equations.map(equationAssignment);
  for (const assignment of assignments) if (assignment && unknownSet.has(assignment.name)) counts.set(assignment.name, (counts.get(assignment.name) ?? 0) + 1);
  const candidates = assignments.flatMap(assignment => assignment && counts.get(assignment.name) === 1
    ? [{ ...assignment, expression: compile(assignment.source) }] : []);
  const definitions = new Map([...candidates, ...derived].map(assignment => [assignment.name, assignment]));
  const visited = new Set<string>(), stack: string[] = [], cyclic = new Set<string>();
  function visit(name: string): void {
    const at = stack.indexOf(name);
    if (at >= 0) { stack.slice(at).forEach(member => cyclic.add(member)); return; }
    if (visited.has(name)) return;
    visited.add(name); stack.push(name);
    for (const dependency of definitions.get(name)!.expression.variables) if (definitions.has(dependency)) visit(dependency);
    stack.pop();
  }
  for (const name of definitions.keys()) visit(name);
  // Keep variables with inclusive search bounds in Newton's state. Its bound
  // projection can hit endpoints exactly; reconstruction could otherwise land
  // just outside an endpoint through floating-point roundoff.
  const removed = candidates.filter(assignment => !cyclic.has(assignment.name) && !bounded.has(assignment.name));
  const names = new Set(removed.map(assignment => assignment.name));
  const available = new Set([...Object.keys(fixed), ...unknowns.filter(name => !names.has(name))]);
  let pending = [...removed, ...derived];
  const ordered: Assignment[] = [];
  while (pending.length) {
    const ready = pending.filter(assignment => assignment.expression.variables.every(name => available.has(name)));
    if (!ready.length) break;
    for (const assignment of ready) { ordered.push(assignment); available.add(assignment.name); }
    pending = pending.filter(assignment => !ready.includes(assignment));
  }
  return { names, equations: equations.filter((_, index) => !assignments[index] || !names.has(assignments[index]!.name)), ordered, circular: pending.length > 0 };
}
