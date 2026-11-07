import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { ArrowDownToLine, FolderOpen, X } from 'lucide-react';
import { loadWorkspaceArchive, MAX_WORKSPACE_ARCHIVE_SIZE } from './core/workspaceArchive';
import { loadWorkspaceFolder, MAX_WORKSPACE_FOLDER_FILES, MAX_WORKSPACE_FOLDER_SIZE } from './core/workspaceImport';
import type { Configuration } from './core/types';

interface Props { onImport: (config: Configuration) => void; onClose: () => void }
interface FolderFile { path: string; file: File }

function checkFolderFiles(files: readonly FolderFile[]): void {
  if (!files.length) throw new Error('The selected folder is empty. Choose the folder containing workspace.json.');
  if (files.length > MAX_WORKSPACE_FOLDER_FILES) throw new Error(`A workspace folder can contain at most ${MAX_WORKSPACE_FOLDER_FILES} files.`);
  if (files.reduce((size, entry) => size + entry.file.size, 0) > MAX_WORKSPACE_FOLDER_SIZE) throw new Error('Workspace folder contents must be no larger than 8 MB.');
}

async function readFolder(files: readonly FolderFile[]): Promise<Configuration> {
  checkFolderFiles(files);
  const contents = [];
  for (const { path, file } of files) contents.push({ path, data: new Uint8Array(await file.arrayBuffer()) });
  return loadWorkspaceFolder(contents);
}

function selectedFolder(files: readonly File[]): FolderFile[] {
  let root: string | undefined;
  const contents = files.map(file => {
    const path = file.webkitRelativePath, separator = path.indexOf('/');
    if (separator < 1 || separator === path.length - 1) throw new Error('Choose the workspace folder itself, containing workspace.json and its elements folder.');
    const folder = path.slice(0, separator);
    root ??= folder;
    if (folder !== root) throw new Error('Choose one workspace folder at a time.');
    return { file, path: path.slice(separator + 1) };
  });
  checkFolderFiles(contents);
  return contents;
}

async function droppedFolder(root: FileSystemDirectoryEntry): Promise<FolderFile[]> {
  const files: FolderFile[] = [];
  let visited = 0, size = 0;
  async function visit(entry: FileSystemEntry, path: string, depth: number): Promise<void> {
    if (++visited > 512 || depth > 32) throw new Error('The folder contains too many entries or nested folders. Choose the folder containing workspace.json.');
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      size += file.size;
      if (files.length >= MAX_WORKSPACE_FOLDER_FILES) throw new Error(`A workspace folder can contain at most ${MAX_WORKSPACE_FOLDER_FILES} files.`);
      if (size > MAX_WORKSPACE_FOLDER_SIZE) throw new Error('Workspace folder contents must be no larger than 8 MB.');
      files.push({ path, file });
      return;
    }
    if (!entry.isDirectory) throw new Error(`Cannot read workspace entry ${path || entry.name}.`);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // Chromium supplies directory entries in batches; keep reading to the end.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await visit(child, path ? `${path}/${child.name}` : child.name, depth + 1);
    }
  }
  await visit(root, '', 0);
  checkFolderFiles(files);
  return files;
}

async function readZIP(file: File): Promise<Configuration> {
  if (file.size > MAX_WORKSPACE_ARCHIVE_SIZE) throw new Error('Please import a workspace ZIP file no larger than 2 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Choose a workspace ZIP file, or use Choose folder for an extracted workspace.');
  return loadWorkspaceArchive(bytes);
}

export default function WorkspaceImport({ onImport, onClose }: Props) {
  const [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const dialog = useRef<HTMLElement>(null), zipInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false), mounted = useRef(true), onCloseRef = useRef(onClose), onImportRef = useRef(onImport);
  const errorId = useId();
  onCloseRef.current = onClose; onImportRef.current = onImport;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
      } else if (event.key === 'Tab') {
        const controls = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not([hidden]):not(:disabled), [tabindex="0"]') ?? []];
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      mounted.current = false;
      document.removeEventListener('keydown', keyboard, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function importWorkspace(read: () => Promise<Configuration>, message: string): void {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setStatus(message); setDragging(false);
    void (async () => {
      try {
        const config = await read();
        onImportRef.current(config); onCloseRef.current();
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : 'The workspace could not be imported.');
      } finally {
        busyRef.current = false;
        if (mounted.current) { setBusy(false); setStatus(''); }
      }
    })();
  }

  function drop(event: DragEvent<HTMLElement>): void {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (busyRef.current) return;
    const items = [...event.dataTransfer.items].filter(item => item.kind === 'file');
    // Read the entry handles before the drop event's data store becomes unavailable.
    const entries = items.map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
    const files = [...event.dataTransfer.files];
    const directory = entries.find(entry => entry?.isDirectory);
    if (directory) {
      importWorkspace(async () => {
        if (items.length !== 1) throw new Error('Drop one workspace ZIP or one workspace folder at a time.');
        return readFolder(await droppedFolder(directory as FileSystemDirectoryEntry));
      }, 'Detected a workspace folder. Reading files…');
    } else if (files.some(file => file.webkitRelativePath)) {
      importWorkspace(async () => readFolder(selectedFolder(files)), 'Detected a workspace folder. Reading files…');
    } else {
      importWorkspace(async () => {
        if (files.length !== 1) throw new Error('Drop one workspace ZIP or one workspace folder at a time.');
        return readZIP(files[0]);
      }, 'Reading workspace ZIP…');
    }
  }

  const close = () => { if (!busyRef.current) onCloseRef.current(); };
  return <div className="modal-backdrop" onClick={close} onDragOver={event => event.preventDefault()} onDrop={drop}>
    <section className="modal workspace-import-modal" role="dialog" aria-modal="true" aria-label="Import workspace" aria-busy={busy} tabIndex={-1} ref={dialog} onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>Import workspace</h2><button className="icon-button" type="button" aria-label="Close import" disabled={busy} onClick={close}><X size={20}/></button></div>
      <div className={`workspace-import-drop ${dragging ? 'dragging' : ''}`} role="region" aria-label="Workspace import drop area"
        onDragEnter={event => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
        <FolderOpen size={30} aria-hidden="true"/>
        <strong>Drop a workspace ZIP or folder here</strong>
        <p>The import detects either format. An extracted folder must contain <code>workspace.json</code> and its <code>elements</code> folder.</p>
      </div>
      <div className="workspace-import-actions">
        <button className="button subtle" type="button" disabled={busy} onClick={() => zipInput.current?.click()}><ArrowDownToLine size={15}/>Choose ZIP</button>
        <button className="button subtle" type="button" disabled={busy} onClick={() => folderInput.current?.click()}><ArrowDownToLine size={15}/>Choose folder</button>
      </div>
      <input hidden type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label="Workspace ZIP file" ref={zipInput} disabled={busy} onChange={event => {
        const input = event.currentTarget, file = input.files?.[0]; input.value = '';
        if (file) importWorkspace(() => readZIP(file), 'Reading workspace ZIP…');
      }}/>
      <input hidden type="file" multiple aria-label="Workspace folder" ref={input => { folderInput.current = input; input?.setAttribute('webkitdirectory', ''); }} disabled={busy} onChange={event => {
        const input = event.currentTarget, files = [...input.files ?? []]; input.value = '';
        if (files.length) importWorkspace(async () => readFolder(selectedFolder(files)), 'Reading workspace folder…');
      }}/>
      {busy && <p className="workspace-import-status" role="status">{status}</p>}
      {error && <div className="diagnostic-error workspace-import-error" role="alert" id={errorId}><strong>Workspace could not be imported</strong><p>{error}</p></div>}
      <p className="diagnostic-context">You can also choose a ZIP or folder using the buttons above. Export continues to create a ZIP file.</p>
      <div className="workspace-import-footer"><button className="button subtle" type="button" disabled={busy} onClick={close}>Cancel</button></div>
    </section>
  </div>;
}
