export type Scope = Record<string, number>;
export interface Variable { name: string; kind: 'unknown' | 'parameter' | 'derived'; value: number; min?: number; max?: number; step?: number; expression?: string }
export interface Region { name: string; condition: string; color: string }
export interface SecondarySweep { parameter: string; min: number; max: number; points: number; logarithmic: boolean; step?: number; startAt?: number }
export interface EditorDocument { id: string; title: string; source: string }
export interface Configuration {
  name: string; description: string; equations: string; variables: Variable[]; constraints: string; regions: Region[];
  /** Source documents share one global model; engine fields are its projection. */
  documents?: EditorDocument[];
  sweep: { parameter: string; min: number; max: number; points: number; logarithmic: boolean; mode: 'free' | 'constrained'; release: string; step?: number; startAt?: number; secondary?: SecondarySweep; additional?: SecondarySweep[] };
  axes: { x: string; y: string }; solver: { tolerance: number; iterations: number; starts: number };
}
export interface Root { values: Scope; residuals: number[]; norm: number; iterations: number; jacobian: number[][]; region: string }
export interface Point extends Root {
  parameter: number; x: number; y: number; ys: (number | null)[]; branch: number; index: number;
  /** Added only to an inspected copy; sweep samples retain compact diagnostics. */
  diagnosticUnknowns?: string[]; diagnosticEquations?: string[];
}
export interface Branch { id: number; points: Point[] }
export interface SweepResult { branches: Branch[]; failures: { index: number; parameter: number; reason: string }[]; solved: number; total: number; elapsed: number; unknowns: string[]; equations: string[] }
