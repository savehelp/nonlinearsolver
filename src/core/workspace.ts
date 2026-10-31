import { compileDocuments, ensureDocuments, PlotSourceError, validateDocuments } from './documents';
import { normalizeSweep } from './sweepPlan';
import { elementDefinitions, parseElementLibrary, type ElementDefinition } from './elements';
import type { Configuration, EditorDocument } from './types';

export const WORKSPACE_STORAGE = 'node-workbench-v2';

/** Portable source, without the engine's duplicate equations/variable tables. */
export interface WorkspaceFile {
  format: 'nonlinear-workbench';
  version: 2;
  name: string;
  description: string;
  tabs: EditorDocument[];
  /** Self-contained snapshots of loaded and referenced element types. */
  elements?: ElementDefinition[];
  settings: {
    solver: Configuration['solver'];
    sweep: { mode: 'free'; parameter: string } | {
      mode: 'constrained'; parameter: string; release: string;
      min: number; max: number; points: number; logarithmic: boolean;
    };
  };
}

export function createWorkspace(config: Configuration): WorkspaceFile {
  const sweep = config.sweep;
  const documents = ensureDocuments(config.documents ? config : structuredClone(config));
  const usesElements = documents.some(document => /(?:^|[;\r\n])\s*element\s+/.test(document.source.replace(/#[^\r\n]*/g, '')));
  return {
    format: 'nonlinear-workbench', version: 2, name: config.name, description: config.description,
    tabs: documents.map(({ id, title, source }) => ({ id, title, source })),
    ...(usesElements || config.elementDefinitions?.length ? { elements: structuredClone(elementDefinitions(config)) } : {}),
    settings: {
      solver: { ...config.solver },
      sweep: sweep.mode === 'free' ? { mode: 'free', parameter: sweep.parameter } : {
        mode: 'constrained', parameter: sweep.parameter, release: sweep.release,
        min: sweep.min, max: sweep.max, points: sweep.points, logarithmic: sweep.logarithmic,
      },
    },
  };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function loadWorkspace(data: unknown): Configuration {
  if (!object(data)) throw new Error('Expected a workspace JSON object.');
  if (data.format !== 'nonlinear-workbench') throw new Error('This is not a nonlinear workbench workspace.');
  if (data.version !== 2) throw new Error(`Unsupported workspace version: ${String(data.version)}.`);
  if (typeof data.name !== 'string' || typeof data.description !== 'string') throw new Error('Workspace name and description must be text.');
  validateDocuments(data.tabs);
  const settings = data.settings;
  if (!object(settings)) throw new Error('Workspace needs solver and sweep settings.');
  const solver = settings.solver;
  if (!object(solver) || !finite(solver.tolerance) || !finite(solver.iterations) || !finite(solver.starts)
    || (Object.hasOwn(solver, 'complex') && typeof solver.complex !== 'boolean')) throw new Error('Invalid workspace solver settings.');
  const sweep = settings.sweep;
  if (!object(sweep) || (sweep.mode !== 'free' && sweep.mode !== 'constrained') || typeof sweep.parameter !== 'string') throw new Error('Invalid workspace sweep selection.');
  if (sweep.mode === 'constrained' && (typeof sweep.parameter !== 'string' || typeof sweep.release !== 'string' || !finite(sweep.min) || !finite(sweep.max)
    || !finite(sweep.points) || typeof sweep.logarithmic !== 'boolean')) throw new Error('Invalid constrained sweep settings.');
  // Range/convergence errors belong to solver diagnostics. Saved in-progress
  // settings must remain loadable, just like incomplete source declarations.
  const config: Configuration = {
    name: data.name, description: data.description,
    documents: data.tabs.map(({ id, title, source }) => ({ id, title, source })),
    equations: '', variables: [], constraints: '', regions: [],
    axes: { x: '', y: '' },
    ...(Object.hasOwn(data, 'elements') ? { elementDefinitions: parseElementLibrary({ format: 'nonlinear-elements', version: 1, elements: data.elements }) } : {}),
    solver: { tolerance: solver.tolerance, iterations: solver.iterations, starts: solver.starts,
      ...(typeof solver.complex === 'boolean' ? { complex: solver.complex } : {}),
    },
    sweep: sweep.mode === 'constrained' ? {
      mode: 'constrained', parameter: sweep.parameter as string, release: sweep.release as string,
      min: sweep.min as number, max: sweep.max as number, points: sweep.points as number, logarithmic: sweep.logarithmic as boolean,
    } : { mode: 'free', parameter: sweep.parameter, release: '', min: 0, max: 1, points: 2, logarithmic: false },
  };
  // A malformed/oversized library is an import error, not an editable math draft.
  if (config.elementDefinitions) elementDefinitions(config);
  try { return normalizeSweep(compileDocuments(config, config.documents!)); }
  catch (error) { return error instanceof PlotSourceError && error.config ? normalizeSweep(error.config) : config; }
}
