import type { Configuration, Root, Scope, SweepResult } from './types';
import { retainedBytes } from './doubleSweep';
import { modelKey } from './projection';
import { parameterSweepPlan } from './sweepPlan';
import { sliceSweeps } from './variables';
import { MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';

/** This is a seed for the next resampling, not a history of earlier models. */
export interface SweepReuse {
  config: Configuration;
  slices: { values: Scope; result: SweepResult }[];
}
export interface ReusableSample { roots: Root[]; error: string }
export type SampleLookup = (parameter: number) => ReusableSample | undefined;
interface SampleRecord { coordinates: number[]; roots: Root[] }
export interface SampleReuseData { model: string; names: string[]; samples: SampleRecord[]; bytes: number }
export const MAX_REUSE_BYTES = 32 * 1024 * 1024;

const raw = (config: Configuration) => !config.axes.curves && config.axes.x === config.sweep.parameter && config.axes.y.trim() === '0';
const coordinateKey = (values: number[]) => JSON.stringify(values);

function plannedValues(config: Configuration): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const [index, axis] of [config.sweep, ...sliceSweeps(config)].entries()) {
    const limit = index ? MAX_SECONDARY_SLICES : MAX_PARAMETER_SAMPLES;
    let values: number[];
    if (Object.hasOwn(axis, 'step')) {
      const variable = config.variables.find(variable => variable.name === axis.parameter);
      values = parameterSweepPlan({ name: axis.parameter, kind: 'parameter', value: axis.startAt ?? variable?.value ?? axis.min, min: axis.min, max: axis.max, step: axis.step }, limit).values;
    } else {
      if (!Number.isInteger(axis.points) || axis.points < 2 || axis.points > limit || !Number.isFinite(axis.min) || !Number.isFinite(axis.max) || axis.min >= axis.max) throw new Error('Invalid resampling plan.');
      values = Array.from({ length: axis.points }, (_, index) => {
        const t = index / (axis.points - 1);
        return axis.logarithmic ? axis.min * (axis.max / axis.min) ** t : axis.min + (axis.max - axis.min) * t;
      });
    }
    if (!values.every(Number.isFinite)) throw new Error('Invalid resampling coordinates.');
    result.set(axis.parameter, new Set(values));
  }
  return result;
}

/** Bound the payload before postMessage clones it into the worker. Only complete
 * successful root sets at exact requested coordinates are eligible. Failures
 * retry, since a changed continuation neighbor may now provide a better seed. */
export function prepareSweepReuse(config: Configuration, source: SweepReuse, maxBytes = MAX_REUSE_BYTES): SampleReuseData | undefined {
  if (!raw(config) || !raw(source.config) || !Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const model = modelKey(config);
  if (modelKey(source.config) !== model) return;
  let requested: Map<string, Set<number>>;
  try { requested = plannedValues(config); } catch { return; }
  const names = [...requested.keys()].sort(), samples: SampleRecord[] = [];
  const retained = new Set<string>();
  let bytes = 4096 + retainedBytes({ model, names }, maxBytes), full = bytes >= maxBytes;
  for (const slice of source.slices) {
    if (full) break;
    // Each progress delta is published only after a complete sample, so all
    // roots for a retained sample index are present even in a partial run.
    const groups = new Map<number, { key: string; sample: SampleRecord; bytes: number }>();
    const omitted = new Set<number>();
    for (const branch of slice.result.branches) for (const point of branch.points) {
      if (omitted.has(point.index)) continue;
      const coordinates = names.map(name => name === source.config.sweep.parameter ? point.parameter : slice.values[name]);
      if (!coordinates.every((value, index) => Number.isFinite(value) && requested.get(names[index])!.has(value))) continue;
      const key = coordinateKey(coordinates);
      if (retained.has(key)) continue;
      let group = groups.get(point.index);
      if (!group) {
        if (full) continue;
        const overhead = 256 + retainedBytes({ coordinates, roots: [] }, maxBytes - bytes);
        if (bytes + overhead > maxBytes) { full = true; continue; }
        group = { key, sample: { coordinates, roots: [] }, bytes: overhead };
        groups.set(point.index, group); bytes += overhead;
      }
      const root: Root = { values: point.values, ...(point.complexValues ? { complexValues: point.complexValues } : {}), residuals: point.residuals, norm: point.norm, iterations: point.iterations, jacobian: [], region: point.region };
      const size = 32 + retainedBytes(root, maxBytes - bytes);
      if (bytes + size > maxBytes) {
        // Never send a truncated root set for a sample with many roots.
        groups.delete(point.index); omitted.add(point.index); bytes -= group.bytes; full = true;
        continue;
      }
      group.sample.roots.push(root); group.bytes += size; bytes += size;
    }
    for (const { key, sample } of groups.values()) {
      if (!sample.roots.length) continue;
      retained.add(key); samples.push(sample);
    }
  }
  return samples.length ? { model, names, samples, bytes } : undefined;
}

/** The lookup owns at most one bounded payload; its bytes are reserved from the
 * existing sweep-data budget while output branches are rebuilt for the new grid. */
export class SampleReuseCache {
  private samples = new Map<string, Root[]>();
  readonly bytes: number;
  private names: string[] = [];
  constructor(config: Configuration, data?: SampleReuseData) {
    this.bytes = data && raw(config) && data.model === modelKey(config) && Number.isFinite(data.bytes) && data.bytes > 0 && data.bytes <= MAX_REUSE_BYTES ? data.bytes : 0;
    if (!this.bytes || !data) return;
    this.names = data.names;
    for (const sample of data.samples) this.samples.set(coordinateKey(sample.coordinates), sample.roots);
  }
  forConfig(config: Configuration): SampleLookup {
    const main = this.names.indexOf(config.sweep.parameter);
    const fixed = this.names.map(name => config.variables.find(variable => variable.name === name)?.value ?? NaN);
    return parameter => {
      if (main < 0) return;
      fixed[main] = parameter;
      const roots = this.samples.get(coordinateKey(fixed));
      return roots ? { roots, error: '' } : undefined;
    };
  }
}
