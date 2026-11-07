import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { clone, rcLowPass, starter } from '../examples';
import { compileDocuments } from './documents';
import { elementDefinitions, type ElementDefinition } from './elements';
import { createWorkspace } from './workspace';
import { createWorkspaceArchive, loadWorkspaceArchive } from './workspaceArchive';
import { loadWorkspaceFolder, MAX_WORKSPACE_FOLDER_FILES, MAX_WORKSPACE_FOLDER_SIZE, type WorkspaceImportFile } from './workspaceImport';
import { prepare, roots } from './solver';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const encode = (data: unknown) => encoder.encode(JSON.stringify(data, null, 2));
const contents = () => unzipSync(createWorkspaceArchive(clone(starter)));
const folder = (files: Record<string, Uint8Array>): WorkspaceImportFile[] => Object.entries(files).map(([path, data]) => ({ path, data }));
const json = (data: Uint8Array) => JSON.parse(decoder.decode(data));

describe('uncompressed workspace folder import', () => {
  it('loads the same source, settings and model snapshots as its ZIP without mutating files', () => {
    const config = clone(rcLowPass);
    config.name = 'Folder café Ω';
    config.solver = { ...config.solver, tolerance: 1e-11, iterations: 175, starts: 7 };
    const archive = createWorkspaceArchive(config), entries = folder(unzipSync(archive));
    const before = entries.map(({ path, data }) => ({ path, data: data.slice() }));
    const imported = loadWorkspaceFolder(entries), zipped = loadWorkspaceArchive(archive);
    expect(createWorkspace(imported)).toEqual(createWorkspace(zipped));
    expect(imported.solver).toEqual(config.solver);
    expect(imported.documents).toEqual(createWorkspace(config).tabs);
    expect(elementDefinitions(imported)).toEqual(elementDefinitions(zipped));
    expect(entries).toEqual(before);
  });

  it('uses edited individual model files and retains unused custom and legacy definitions', () => {
    const gain: ElementDefinition = { name: 'Gain', terminals: ['input'], parameters: { gain: { value: 2 } }, equations: ['output = gain*input'] };
    const legacy: ElementDefinition = { name: 'NMOSFET', terminals: ['g'], parameters: { VTH: { value: .7 } }, equations: ['output = g+VTH'] };
    const base = clone(starter); base.elementDefinitions = [gain, legacy];
    const config = compileDocuments(base, [{ id: 'model', title: 'Model', source: '# preserve exact text\nparameter t 0 .5 -1 1 sweep\nelement Gain A1\nA1.input = t;\nset_time_axis t\nplot A1.output\n' }]);
    const files = unzipSync(createWorkspaceArchive(config)), library = json(files['elements/Gain.json']);
    library.elements[0].parameters.gain.value = 5;
    files['elements/Gain.json'] = encode(library);
    const imported = loadWorkspaceFolder(folder(files));
    expect(imported.documents).toEqual(config.documents);
    expect(imported.elementDefinitions!.find(definition => definition.name === 'NMOSFET')).toEqual(legacy);
    expect(roots(prepare(imported, .5), imported.solver).roots[0].values['A1.output']).toBe(2.5);
    expect(createWorkspace(imported)).toEqual(createWorkspace(loadWorkspaceArchive(zipSync(files))));
  });

  it('preserves unfinished source and unknown future-model declarations for editing', () => {
    const config = clone(starter);
    config.documents = [{ id: 'draft', title: 'Draft', source: '\n# do not lose this\nelement FutureModel M1\nunknown unfinished (\n' }];
    const imported = loadWorkspaceFolder(folder(unzipSync(createWorkspaceArchive(config))));
    expect(imported.documents).toEqual(config.documents);
    expect(imported.variables).toEqual([]);
  });

  it('requires workspace.json at the selected folder root and all referenced element files', () => {
    const files = contents();
    expect(() => loadWorkspaceFolder(folder(files).map(file => ({ ...file, path: `outer/${file.path}` })))).toThrow(/missing workspace\.json at its root/);
    delete files['elements/NMOSFET.json'];
    expect(() => loadWorkspaceFolder(folder(files))).toThrow(/missing element file elements\/NMOSFET\.json/);
  });

  it('rejects duplicate paths, unsafe relative paths and oversized folder selections', () => {
    const files = folder(contents());
    expect(() => loadWorkspaceFolder([...files, { ...files[0], path: 'WORKSPACE.JSON' }])).toThrow(/Duplicate workspace file/);
    for (const path of ['../escape.json', '/workspace.json', 'C:/workspace.json', 'elements\\Gain.json', './workspace.json']) {
      expect(() => loadWorkspaceFolder([...files, { path, data: encode({}) }])).toThrow(/Unsafe workspace file path/);
    }
    expect(() => loadWorkspaceFolder([])).toThrow(/1–128 files/);
    expect(() => loadWorkspaceFolder(Array.from({ length: MAX_WORKSPACE_FOLDER_FILES + 1 }, (_, i) => ({ path: `${i}.json`, data: encode({}) })))).toThrow(/1–128 files/);
    expect(() => loadWorkspaceFolder([{ path: 'workspace.json', data: new Uint8Array(MAX_WORKSPACE_FOLDER_SIZE + 1) }])).toThrow(/exceed 8 MB/);
  });

  it('shares manifest and model validation with ZIP import', () => {
    for (const update of [
      (main: Record<string, unknown>) => { main.version = 2; },
      (main: Record<string, unknown>) => { main.elementFiles = ['elements/NMOSFET.json', 'elements/NMOSFET.json']; },
      (main: Record<string, unknown>) => { main.elementFiles = ['../NMOSFET.json']; },
      (main: Record<string, unknown>) => { main.elements = []; },
    ]) {
      const files = contents(), main = json(files['workspace.json']); update(main); files['workspace.json'] = encode(main);
      expect(() => loadWorkspaceFolder(folder(files))).toThrow();
      expect(() => loadWorkspaceArchive(zipSync(files))).toThrow();
    }
    const files = contents(); files['elements/PMOSFET.json'] = files['elements/NMOSFET.json'];
    expect(() => loadWorkspaceFolder(folder(files))).toThrow(/appears in more than one file/);
  });

  it('rejects malformed JSON, invalid UTF-8 and invalid definitions before loading', () => {
    for (const path of ['workspace.json', 'elements/NMOSFET.json']) {
      const invalid = contents(); invalid[path] = encoder.encode('{broken');
      expect(() => loadWorkspaceFolder(folder(invalid))).toThrow(/invalid JSON/);
      invalid[path] = Uint8Array.of(0xff, 0xff);
      expect(() => loadWorkspaceFolder(folder(invalid))).toThrow(/UTF-8/);
    }
    const files = contents(), library = json(files['elements/NMOSFET.json']);
    library.elements[0].equations = ['id = undeclared']; files['elements/NMOSFET.json'] = encode(library);
    expect(() => loadWorkspaceFolder(folder(files))).toThrow(/not a declared local member/);
  });

  it('does not substitute a bundled model whose snapshot was removed from the folder manifest', () => {
    const config = clone(starter);
    config.documents = [{ id: 'device', title: 'Device', source: 'element NMOSFET M1\n' }];
    const files = unzipSync(createWorkspaceArchive(config)), main = json(files['workspace.json']);
    main.elementFiles = ['elements/PMOSFET.json']; files['workspace.json'] = encode(main); delete files['elements/NMOSFET.json'];
    expect(() => loadWorkspaceFolder(folder(files))).toThrow(/missing the element definition for NMOSFET/);
  });
});
