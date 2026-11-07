import { describe, expect, it } from 'vitest';
import { Zip, ZipDeflate, unzipSync, zipSync } from 'fflate';
import { clone, rcLowPass, starter } from '../examples';
import { compileDocuments } from './documents';
import { BUILTIN_ELEMENTS, createElementLibrary, elementDefinitions, type ElementDefinition } from './elements';
import { createWorkspace } from './workspace';
import { createWorkspaceArchive, loadWorkspaceArchive, MAX_WORKSPACE_ARCHIVE_CONTENT, MAX_WORKSPACE_ARCHIVE_SIZE } from './workspaceArchive';
import { prepare, roots } from './solver';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const stringify = (data: unknown) => encoder.encode(JSON.stringify(data, null, 2));
type Files = Record<string, Uint8Array>;
function main(files: Files): Record<string, unknown> { return JSON.parse(decoder.decode(files['workspace.json'])); }
function changeMain(files: Files, update: (main: Record<string, unknown>) => void): Files {
  const value = main(files); update(value); return { ...files, 'workspace.json': stringify(value) };
}
function files() { return unzipSync(createWorkspaceArchive(clone(starter))); }
function entry(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  let central = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const length = view.getUint16(central + 28, true);
    const filename = decoder.decode(bytes.subarray(central + 46, central + 46 + length));
    if (filename === name) {
      const local = view.getUint32(central + 42, true);
      return { central, local, data: local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), view };
    }
    central += 46 + length + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  throw new Error(`Missing test entry ${name}`);
}

const gain: ElementDefinition = { name: 'Gain', mode: 'both', terminals: ['input'], parameters: { gain: { value: 2 } }, equations: ['output = gain*input'] };
function model() {
  const config = clone(starter);
  const legacy: ElementDefinition = { name: 'NMOSFET', terminals: ['g'], parameters: { VTH: { value: .7 } }, equations: ['output = g + VTH'] };
  config.elementDefinitions = [legacy, gain];
  return compileDocuments(config, [{ id: 'circuit', title: 'Circuit', source: '# exact source; comments, accents: café Ω\nparameter t 0 .5 -1 1 sweep\n\nelement Gain A\nA.input = t;\nset_time_axis t\nplot A.output\n' }]);
}

describe('workspace ZIP export and import', () => {
  it('separates source from every model and uses individually loadable element JSON files', () => {
    const config = model(), before = structuredClone(config), archive = createWorkspaceArchive(config), contents = unzipSync(archive), workspace = main(contents);
    expect(workspace).toMatchObject({ format: 'nonlinear-workbench', version: 3, tabs: config.documents });
    expect(workspace).not.toHaveProperty('elements');
    expect(workspace).not.toHaveProperty('equations');
    expect(workspace.elementFiles).toEqual(['elements/NMOSFET.json', 'elements/PMOSFET.json', 'elements/Gain.json']);
    expect(Object.keys(contents)).toEqual(['workspace.json', ...workspace.elementFiles as string[]]);
    const exported = (workspace.elementFiles as string[]).map(path => JSON.parse(decoder.decode(contents[path])));
    expect(exported).toEqual(elementDefinitions(config).map(definition => createElementLibrary([definition])));
    expect(config).toEqual(before);
    const restored = loadWorkspaceArchive(archive);
    expect(restored.documents).toEqual(config.documents);
    expect(restored.solver).toEqual(config.solver);
    expect(restored.sweep).toEqual(config.sweep);
    expect(elementDefinitions(restored)).toEqual(elementDefinitions(config));
    expect(createWorkspace(restored)).toEqual(createWorkspace(config));
    expect(roots(prepare(restored, .5), restored.solver).roots[0].values['A.output']).toBe(1);
  });

  it('snapshots bundled models even when a workspace has no element instances', () => {
    const archive = createWorkspaceArchive(clone(rcLowPass)), contents = unzipSync(archive), restored = loadWorkspaceArchive(archive);
    expect(main(contents).elementFiles).toEqual(['elements/NMOSFET.json', 'elements/PMOSFET.json']);
    expect(restored.solver.complex).toBe(true);
    expect(restored.elementDefinitions).toEqual(BUILTIN_ELEMENTS);
    expect(restored.documents).toEqual(createWorkspace(clone(rcLowPass)).tabs);
  });

  it('imports streaming ZIP data descriptors and explicit directory entries', () => {
    const contents = files(), chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
    for (const [path, content] of Object.entries(contents)) {
      const file = new ZipDeflate(path); zip.add(file); file.push(content, true);
    }
    zip.end();
    const archive = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length; }
    expect(loadWorkspaceArchive(archive).documents).toEqual(createWorkspace(clone(starter)).tabs);
    expect(loadWorkspaceArchive(zipSync({ ...contents, 'elements/': new Uint8Array() })).elementDefinitions).toEqual(BUILTIN_ELEMENTS);
  });

  it.each([0, 6] as const)('imports ordinary stored/deflated ZIPs (compression level %s) and editable model files', level => {
    const config = model(), contents = unzipSync(createWorkspaceArchive(config));
    const library = JSON.parse(decoder.decode(contents['elements/Gain.json']));
    library.elements[0].parameters.gain.value = 5;
    contents['elements/Gain.json'] = stringify(library);
    const restored = loadWorkspaceArchive(zipSync(contents, { level }));
    expect(roots(prepare(restored, .5), restored.solver).roots[0].values['A.output']).toBe(2.5);
    expect(restored.elementDefinitions!.find(definition => definition.name === 'NMOSFET')!.parameters.VTH.value).toBe(.7);
  });

  it('keeps incomplete source and unknown future model declarations as editable drafts', () => {
    const config = clone(starter);
    config.documents = [{ id: 'notes', title: 'Notes', source: '# keep this draft\nelement FutureModel M1\nunknown unfinished (\n' }];
    const restored = loadWorkspaceArchive(createWorkspaceArchive(config));
    expect(restored.documents).toEqual(config.documents);
    expect(restored.variables).toEqual([]);
  });

  it('uses portable distinct filenames for types that differ only in case or use Windows device names', () => {
    const config = clone(starter);
    config.elementDefinitions = [gain, { ...gain, name: 'gain' }, { ...gain, name: 'CON' }];
    const archive = createWorkspaceArchive(config), contents = unzipSync(archive);
    const paths = main(contents).elementFiles as string[];
    expect(new Set(paths.map(path => path.toLowerCase())).size).toBe(paths.length);
    expect(paths).not.toContain('elements/CON.json');
    expect(elementDefinitions(loadWorkspaceArchive(archive))).toEqual(elementDefinitions(config));
  });

  it('requires the main workspace and every referenced model, without substituting bundled defaults', () => {
    const contents = files(), missingMain = { ...contents }; delete missingMain['workspace.json'];
    expect(() => loadWorkspaceArchive(zipSync(missingMain))).toThrow(/missing workspace\.json/);
    const missingModel = { ...contents }; delete missingModel['elements/NMOSFET.json'];
    expect(() => loadWorkspaceArchive(zipSync(missingModel))).toThrow(/missing element file elements\/NMOSFET\.json/);
    const config = clone(starter); config.documents = [{ id: 'device', title: 'Device', source: 'element NMOSFET M1\n' }];
    const missingReference = changeMain(unzipSync(createWorkspaceArchive(config)), value => { value.elementFiles = ['elements/PMOSFET.json']; });
    delete missingReference['elements/NMOSFET.json'];
    expect(() => loadWorkspaceArchive(zipSync(missingReference))).toThrow(/missing the element definition for NMOSFET/);
  });

  it('rejects invalid manifests, duplicate references/types and conflicting embedded definitions', () => {
    for (const update of [
      (value: Record<string, unknown>) => { value.version = 99; },
      (value: Record<string, unknown>) => { value.elementFiles = null; },
      (value: Record<string, unknown>) => { value.elementFiles = ['elements/NMOSFET.json', 'elements/NMOSFET.json']; },
      (value: Record<string, unknown>) => { value.elementFiles = ['../elements/NMOSFET.json']; },
      (value: Record<string, unknown>) => { value.elements = []; },
    ]) expect(() => loadWorkspaceArchive(zipSync(changeMain(files(), update)))).toThrow();
    const duplicate = files(); duplicate['elements/PMOSFET.json'] = duplicate['elements/NMOSFET.json'];
    expect(() => loadWorkspaceArchive(zipSync(duplicate))).toThrow(/appears in more than one file/);
    const empty = files(); empty['elements/NMOSFET.json'] = stringify(createElementLibrary([]));
    expect(() => loadWorkspaceArchive(zipSync(empty))).toThrow(/exactly one element type/);
  });

  it('reports malformed workspace/model JSON and validates loaded element schemas', () => {
    for (const path of ['workspace.json', 'elements/NMOSFET.json']) {
      const contents = files(); contents[path] = encoder.encode('{broken');
      expect(() => loadWorkspaceArchive(zipSync(contents))).toThrow(/invalid JSON/);
    }
    const invalid = files(); invalid['elements/NMOSFET.json'] = stringify({ format: 'nonlinear-elements', version: 1, elements: [{ ...gain, equations: ['output = undeclared'] }] });
    expect(() => loadWorkspaceArchive(zipSync(invalid))).toThrow(/not a declared local member/);
    const utf8 = files(); utf8['workspace.json'] = Uint8Array.of(0xff, 0xff);
    expect(() => loadWorkspaceArchive(zipSync(utf8))).toThrow(/UTF-8/);
  });

  it('rejects raw JSON, truncated ZIPs, unsafe paths and duplicate entry names', () => {
    expect(() => loadWorkspaceArchive(stringify(createWorkspace(clone(starter))))).toThrow(/ZIP/);
    const archive = createWorkspaceArchive(clone(starter));
    expect(() => loadWorkspaceArchive(archive.subarray(0, archive.length - 1))).toThrow(/truncated/);
    expect(() => loadWorkspaceArchive(zipSync({ ...files(), '../escape.json': stringify({}) }))).toThrow(/Unsafe ZIP entry path/);
    const duplicate = zipSync(files()), location = entry(duplicate, 'elements/PMOSFET.json');
    const name = encoder.encode('elements/NMOSFET.json');
    duplicate.set(name, location.central + 46); duplicate.set(name, location.local + 30);
    expect(() => loadWorkspaceArchive(duplicate)).toThrow(/Duplicate ZIP entry/);
  });

  it('checks checksum, compression method and encryption flags before accepting an archive', () => {
    const corrupt = zipSync(files(), { level: 0 }), stored = entry(corrupt, 'workspace.json');
    corrupt[stored.data] ^= 1;
    expect(() => loadWorkspaceArchive(corrupt)).toThrow(/checksum/);
    const unsupported = zipSync(files()), method = entry(unsupported, 'workspace.json');
    method.view.setUint16(method.central + 10, 99, true); method.view.setUint16(method.local + 8, 99, true);
    expect(() => loadWorkspaceArchive(unsupported)).toThrow(/stored or DEFLATE/);
    const encrypted = zipSync(files()), flags = entry(encrypted, 'workspace.json');
    flags.view.setUint16(flags.central + 8, 1, true); flags.view.setUint16(flags.local + 6, 1, true);
    expect(() => loadWorkspaceArchive(encrypted)).toThrow(/Encrypted/);
  });

  it('limits compressed bytes, advertised expansion, actual expansion and entry count', () => {
    expect(() => loadWorkspaceArchive(new Uint8Array(MAX_WORKSPACE_ARCHIVE_SIZE + 1))).toThrow(/smaller than 2 MB/);
    const advertised = zipSync(files()), declared = entry(advertised, 'workspace.json');
    declared.view.setUint32(declared.central + 24, MAX_WORKSPACE_ARCHIVE_CONTENT + 1, true);
    declared.view.setUint32(declared.local + 22, MAX_WORKSPACE_ARCHIVE_CONTENT + 1, true);
    expect(() => loadWorkspaceArchive(advertised)).toThrow(/exceed 8 MB/);
    const actual = zipSync({ ...files(), 'oversized.json': encoder.encode('x'.repeat(500_000)) }), falseSize = entry(actual, 'oversized.json');
    falseSize.view.setUint32(falseSize.central + 24, 10, true); falseSize.view.setUint32(falseSize.local + 22, 10, true);
    expect(() => loadWorkspaceArchive(actual)).toThrow(/exceeds its declared size/);
    const many: Files = {};
    for (let index = 0; index < 129; index++) many[`${index}.json`] = stringify({});
    expect(() => loadWorkspaceArchive(zipSync(many))).toThrow(/1–128 entries/);
  });
});
