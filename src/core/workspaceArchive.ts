import { Inflate, zipSync } from 'fflate';
import { BUILTIN_ELEMENTS, createElementLibrary, elementDefinitions, MAX_ELEMENT_TYPES, parseElementLibrary, type ElementDefinition } from './elements';
import { createWorkspace, loadWorkspace, type WorkspaceFile } from './workspace';
import type { Configuration } from './types';

export const MAX_WORKSPACE_ARCHIVE_SIZE = 2_000_000;
export const MAX_WORKSPACE_ARCHIVE_CONTENT = 8_000_000;
export const MAX_WORKSPACE_FILES = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new Error(message); }
interface ArchiveWorkspace extends Omit<WorkspaceFile, 'version' | 'elements'> { version: 3; elementFiles: string[] }
interface ZipEntry { name: string; method: number; compressed: Uint8Array; size: number; crc: number }
export interface WorkspaceImportFile { path: string; data: Uint8Array }

function json(data: Uint8Array, path: string): unknown {
  let text: string;
  try { text = decoder.decode(data); } catch { return fail(`${path}: expected UTF-8 JSON text.`); }
  try { return JSON.parse(text); } catch { return fail(`${path}: invalid JSON.`); }
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 256 && !/[\\:\x00-\x1f\x7f]/u.test(path)
    && !path.startsWith('/') && path.replace(/\/$/u, '').split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Export one ordinary element-library JSON per type so each can be reused independently. */
export function createWorkspaceArchive(config: Configuration): Uint8Array {
  const { elements: _elements, version: _version, ...workspace } = createWorkspace(config);
  const definitions = elementDefinitions(config), used = new Set<string>();
  const files: Record<string, Uint8Array> = Object.create(null);
  const elementFiles = definitions.map((definition, index) => {
    let basename = definition.name;
    if (used.has(basename.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(basename)) basename = `${index + 1}-${basename}`;
    used.add(basename.toLowerCase());
    const path = `elements/${basename}.json`;
    files[path] = encoder.encode(JSON.stringify(createElementLibrary([definition]), null, 2));
    return path;
  });
  const main: ArchiveWorkspace = { ...workspace, version: 3, elementFiles };
  const allFiles = { 'workspace.json': encoder.encode(JSON.stringify(main, null, 2)), ...files };
  if (Object.values(allFiles).reduce((size, file) => size + file.length, 0) > MAX_WORKSPACE_ARCHIVE_CONTENT) fail('Workspace archive contents exceed 8 MB.');
  const archive = zipSync(allFiles, { level: 6 });
  if (archive.length > MAX_WORKSPACE_ARCHIVE_SIZE) fail('Workspace ZIP must be smaller than 2 MB.');
  return archive;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Inspect sizes and paths before inflating; do not trust ZIP size declarations alone. */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > MAX_WORKSPACE_ARCHIVE_SIZE) fail('Please import a workspace ZIP smaller than 2 MB.');
  if (bytes.length < 22) fail('Expected a workspace ZIP archive.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('Invalid or truncated workspace ZIP archive.');
  const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) fail('Multi-part ZIP archives are not supported.');
  if (count === 65535 || centralSize === 0xffffffff || centralStart === 0xffffffff) fail('ZIP64 workspace archives are not supported.');
  if (!count || count > MAX_WORKSPACE_FILES) fail(`Workspace ZIP must contain 1–${MAX_WORKSPACE_FILES} entries.`);
  if (centralStart + centralSize !== end) fail('Invalid ZIP directory size or offset.');
  let offset = centralStart, totalSize = 0;
  const entries: ZipEntry[] = [], names = new Set<string>(), ranges: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) fail('Invalid or truncated ZIP directory.');
    const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16);
    const compressedSize = u32(offset + 20), size = u32(offset + 24);
    const nameSize = u16(offset + 28), extraSize = u16(offset + 30), commentSize = u16(offset + 32), start = u32(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || start + 30 > centralStart) fail('Invalid or truncated ZIP entry.');
    if (u16(offset + 34)) fail('Multi-part ZIP archives are not supported.');
    if (flags & ~0x080e) fail('Encrypted or unsupported ZIP entries are not supported.');
    if (method !== 0 && method !== 8) fail('Workspace ZIP entries must use stored or DEFLATE compression.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || start === 0xffffffff) fail('ZIP64 workspace archives are not supported.');
    let name: string;
    try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize)); }
    catch { return fail('ZIP entry names must use UTF-8.'); }
    if (!safePath(name)) fail(`Unsafe ZIP entry path: ${name}.`);
    const key = name.toLowerCase();
    if (names.has(key)) fail(`Duplicate ZIP entry: ${name}.`);
    names.add(key);
    totalSize += size;
    if (totalSize > MAX_WORKSPACE_ARCHIVE_CONTENT) fail('Uncompressed workspace ZIP contents exceed 8 MB.');
    if (u32(start) !== 0x04034b50 || u16(start + 6) !== flags || u16(start + 8) !== method) fail(`Invalid ZIP local header for ${name}.`);
    const localNameSize = u16(start + 26), localExtraSize = u16(start + 28), dataStart = start + 30 + localNameSize + localExtraSize;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralStart || localNameSize !== nameSize
      || !bytes.subarray(start + 30, start + 30 + localNameSize).every((byte, i) => byte === bytes[offset + 46 + i])) fail(`Invalid ZIP data for ${name}.`);
    if (!(flags & 8) && (u32(start + 14) !== crc || u32(start + 18) !== compressedSize || u32(start + 22) !== size)) fail(`Inconsistent ZIP sizes or checksum for ${name}.`);
    if (method === 0 && compressedSize !== size) fail(`Invalid stored ZIP size for ${name}.`);
    if (name.endsWith('/') && size !== 0) fail(`ZIP directory ${name} must be empty.`);
    ranges.push([start, dataEnd]);
    entries.push({ name, method, compressed: bytes.subarray(dataStart, dataEnd), size, crc });
    offset = next;
  }
  if (offset !== end) fail('Invalid ZIP directory length.');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) fail('ZIP entry data overlaps.');
  return entries;
}

function unpack(entry: ZipEntry): Uint8Array {
  let data: Uint8Array;
  if (entry.method === 0) data = entry.compressed;
  else {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const inflater = new Inflate(chunk => {
      length += chunk.length;
      if (length > entry.size || length > MAX_WORKSPACE_ARCHIVE_CONTENT) fail(`${entry.name}: inflated ZIP data exceeds its declared size.`);
      chunks.push(chunk);
    });
    try {
      // Each input chunk bounds temporary output even if the advertised size is false.
      for (let offset = 0; offset < entry.compressed.length; offset += 1024) inflater.push(entry.compressed.subarray(offset, offset + 1024), offset + 1024 >= entry.compressed.length);
      if (!entry.compressed.length) inflater.push(entry.compressed, true);
    } catch (error) {
      fail(`${entry.name}: invalid ZIP data (${error instanceof Error ? error.message : 'DEFLATE failed'}).`);
    }
    if (length !== entry.size) fail(`${entry.name}: uncompressed ZIP size does not match.`);
    data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  }
  if (crc32(data) !== entry.crc) fail(`${entry.name}: ZIP checksum does not match.`);
  return data;
}

/** Load everything before replacing the live workspace; missing models never fall back silently. */
export function loadWorkspaceArchive(bytes: Uint8Array): Configuration {
  return loadWorkspaceFiles(zipEntries(bytes).map(entry => ({ path: entry.name, data: unpack(entry) })));
}

/** Shared assembly for extracted ZIP entries and an uncompressed workspace folder. */
export function loadWorkspaceFiles(entries: readonly WorkspaceImportFile[]): Configuration {
  if (!entries.length || entries.length > MAX_WORKSPACE_FILES) fail(`Workspace must contain 1–${MAX_WORKSPACE_FILES} files.`);
  const files = new Map<string, Uint8Array>(), paths = new Set<string>();
  let totalSize = 0;
  for (const { path, data } of entries) {
    if (!safePath(path)) fail(`Unsafe workspace file path: ${path}.`);
    const key = path.toLowerCase();
    if (paths.has(key)) fail(`Duplicate workspace file: ${path}.`);
    paths.add(key);
    totalSize += data.byteLength;
    if (totalSize > MAX_WORKSPACE_ARCHIVE_CONTENT) fail('Workspace contents exceed 8 MB.');
    if (path.endsWith('/') && data.byteLength) fail(`Workspace directory ${path} must be empty.`);
    files.set(path, data);
  }
  const mainBytes = files.get('workspace.json');
  if (!mainBytes) fail('Workspace is missing workspace.json at its root.');
  const main = json(mainBytes, 'workspace.json');
  if (!object(main) || main.format !== 'nonlinear-workbench') fail('workspace.json is not a nonlinear workbench workspace.');
  if (main.version !== 3) fail(`Unsupported workspace version: ${String(main.version)}.`);
  if (Object.hasOwn(main, 'elements')) fail('workspace.json must reference separate element files, not embedded elements.');
  if (!Array.isArray(main.elementFiles) || main.elementFiles.length > MAX_ELEMENT_TYPES) fail(`workspace.json needs an elementFiles list of at most ${MAX_ELEMENT_TYPES} paths.`);
  const references = new Set<string>(), typeNames = new Set<string>(), definitions: ElementDefinition[] = [];
  for (const path of main.elementFiles) {
    if (typeof path !== 'string' || !safePath(path) || !/^elements\/[^/]+\.json$/u.test(path)) fail('Element file references must name JSON files inside elements/.');
    if (references.has(path.toLowerCase())) fail(`Duplicate element file reference: ${path}.`);
    references.add(path.toLowerCase());
    const content = files.get(path);
    if (!content) fail(`Workspace is missing element file ${path}.`);
    let incoming: ElementDefinition[];
    try { incoming = parseElementLibrary(json(content, path)); }
    catch (error) { return fail(`${path}: ${error instanceof Error ? error.message : 'Invalid element definition.'}`); }
    if (incoming.length !== 1) fail(`${path} must contain exactly one element type.`);
    if (typeNames.has(incoming[0].name)) fail(`Element type ${incoming[0].name} appears in more than one file.`);
    typeNames.add(incoming[0].name); definitions.push(incoming[0]);
  }
  // Validate the combined limit as well as each independent file.
  createElementLibrary(definitions);
  // Existing bundled names must use the archive's snapshot. Unknown names stay
  // editable drafts, as they do in browser-saved workspaces.
  const bundledNames = new Set(BUILTIN_ELEMENTS.map(definition => definition.name));
  if (Array.isArray(main.tabs)) for (const tab of main.tabs) if (object(tab) && typeof tab.source === 'string') {
    const source = tab.source.replace(/#[^\r\n]*/gu, '');
    for (const match of source.matchAll(/(?:^|[;\r\n])\s*element\s+([A-Za-z_][A-Za-z_0-9]*)\s+/gu)) {
      if (bundledNames.has(match[1]) && !typeNames.has(match[1])) fail(`Workspace is missing the element definition for ${match[1]}.`);
    }
  }
  return loadWorkspace({ ...main, version: 2, elements: definitions });
}
