export type Scope = Record<string, number>;
export interface Complex { re: number; im: number }
export type ComplexScope = Record<string, number | Complex>;
export interface Variable { name: string; kind: 'unknown' | 'parameter' | 'derived'; value: number; min?: number; max?: number; step?: number; expression?: string; scale?: number }
export interface Region { name: string; condition: string; color: string }
export interface SecondarySweep { parameter: string; min: number; max: number; points: number; logarithmic: boolean; step?: number; startAt?: number }
export interface EditorDocument { id: string; title: string; source: string }
export interface PlotCurve { x: string; y: string }
export interface PlotTransition { axis: 'x' | 'y'; expression: string }
export interface Configuration {
  name: string; description: string; equations: string; variables: Variable[]; constraints: string; regions: Region[];
  /** Source documents share one global model; engine fields are its projection. */
  documents?: EditorDocument[];
  sweep: { parameter: string; min: number; max: number; points: number; logarithmic: boolean; mode: 'free' | 'constrained'; release: string; step?: number; startAt?: number; secondary?: SecondarySweep; additional?: SecondarySweep[] };
  /** x is the traversal parameter; optional curves choose displayed coordinates. */
  axes: { x: string; y: string; curves?: PlotCurve[]; transitions?: PlotTransition[] }; solver: { tolerance: number; iterations: number; starts: number; complex?: boolean };
}
export interface Root { values: Scope; complexValues?: Record<string, Complex>; residuals: number[]; norm: number; iterations: number; jacobian: number[][]; region: string }
export interface Point extends Root {
  parameter: number; x: number; y: number; ys: (number | null)[]; branch: number; index: number;
  /** Per-curve horizontal coordinates, in the same order as ys. */
  xs?: (number | null)[];
  /** Added only to an inspected copy; sweep samples retain compact diagnostics. */
  diagnosticUnknowns?: string[]; diagnosticEquations?: string[];
}
export interface Branch { id: number; points: Point[] }
export interface SweepResult { branches: Branch[]; failures: { index: number; parameter: number; reason: string }[]; solved: number; total: number; elapsed: number; unknowns: string[]; equations: string[]; computed?: number; reused?: number }
