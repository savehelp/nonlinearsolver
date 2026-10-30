import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { EditorDocument } from './core/types';

interface Props {
  documents: EditorDocument[];
  resetKey: number;
  error?: string;
  onChange: (documents: EditorDocument[]) => void;
}
interface EditorView { start: number; end: number; top: number; left: number }

export default function WorkspaceEditor({ documents, resetKey, error, onChange }: Props) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? '');
  const [renaming, setRenaming] = useState<string | null>(null), [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null), numbers = useRef<HTMLDivElement>(null), renameInput = useRef<HTMLInputElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const views = useRef(new Map<string, EditorView>());
  const active = documents.find(document => document.id === selectedId) ?? documents[0];
  const lineNumbers = active ? Array.from({ length: active.source.split('\n').length }, (_, index) => index + 1).join('\n') : '';

  useEffect(() => {
    views.current.clear(); setSelectedId(documents[0]?.id ?? ''); setRenaming(null); setDeleting(null);
  }, [resetKey]);
  useLayoutEffect(() => {
    if (!active || !editor.current) return;
    const view = views.current.get(active.id);
    editor.current.setSelectionRange(view?.start ?? 0, view?.end ?? 0);
    editor.current.scrollTop = view?.top ?? 0; editor.current.scrollLeft = view?.left ?? 0;
    if (numbers.current) numbers.current.scrollTop = editor.current.scrollTop;
  }, [active?.id]);
  useEffect(() => { if (renaming) { renameInput.current?.focus(); renameInput.current?.select(); } }, [renaming]);

  if (!active) return null;
  function remember() {
    const input = editor.current;
    if (input && active) views.current.set(active.id, { start: input.selectionStart, end: input.selectionEnd, top: input.scrollTop, left: input.scrollLeft });
  }
  function select(id: string, focus = false) {
    remember(); setSelectedId(id); setRenaming(null); setDeleting(null);
    if (focus) requestAnimationFrame(() => buttons.current.get(id)?.focus());
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = documents.findIndex(document => document.id === id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? documents.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % documents.length
      : event.key === 'ArrowLeft' ? (index + documents.length - 1) % documents.length : -1;
    if (next < 0) return;
    event.preventDefault(); select(documents[next].id, true);
  }
  function add() {
    remember();
    let index = 1;
    while (documents.some(document => document.title === `Tab ${index}`)) index++;
    const document = { id: crypto.randomUUID(), title: `Tab ${index}`, source: '' };
    onChange([...documents, document]); setSelectedId(document.id); setRenaming(null); setDeleting(null);
    requestAnimationFrame(() => editor.current?.focus());
  }
  function beginRename(id: string) {
    const document = documents.find(document => document.id === id);
    if (!document) return;
    select(id); setTitle(document.title); setRenaming(id);
  }
  function saveTitle() {
    const next = title.trim();
    if (!next || !renaming) return;
    onChange(documents.map(document => document.id === renaming ? { ...document, title: next } : document));
    setRenaming(null); requestAnimationFrame(() => buttons.current.get(active.id)?.focus());
  }
  function remove(id: string) {
    if (documents.length < 2) return;
    remember();
    const index = documents.findIndex(document => document.id === id);
    const remaining = documents.filter(document => document.id !== id);
    const nextId = remaining[Math.min(index, remaining.length - 1)].id;
    views.current.delete(id); onChange(remaining); setSelectedId(nextId); setRenaming(null); setDeleting(null);
    requestAnimationFrame(() => buttons.current.get(nextId)?.focus());
  }
  function edit(source: string) {
    onChange(documents.map(document => document.id === active.id ? { ...document, source } : document));
  }

  return <div className="workspace-source-editor">
    <div className="source-tabs-row">
      {renaming ? <div className="source-rename"><input ref={renameInput} aria-label="Tab name" value={title} maxLength={80} onChange={event => setTitle(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); saveTitle(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); requestAnimationFrame(() => buttons.current.get(active.id)?.focus()); }
      }}/></div> : <div className="source-tabs" role="tablist" aria-label="Workspace source tabs">
        {documents.map(document => <button key={document.id} className="source-tab" type="button" role="tab"
          id={`source-tab-${document.id}`} aria-controls="workspace-source-panel" aria-selected={document.id === active.id} tabIndex={document.id === active.id ? 0 : -1}
          ref={button => { if (button) buttons.current.set(document.id, button); else buttons.current.delete(document.id); }}
          title={`${document.title} — double-click to rename`} onClick={() => select(document.id)} onDoubleClick={() => beginRename(document.id)} onKeyDown={event => tabKey(event, document.id)}>
          {document.title}
        </button>)}
      </div>}
      <div className="source-tab-actions" role="group" aria-label="Tab actions">
        <button className="icon-button" type="button" aria-label="Add source tab" title={documents.length >= 32 ? 'Maximum of 32 tabs' : 'Add source tab'} disabled={documents.length >= 32} onClick={add}><Plus size={15}/></button>
        {renaming ? <><button className="icon-button" type="button" aria-label="Save tab name" title="Save tab name" disabled={!title.trim()} onClick={saveTitle}><Check size={13}/></button><button className="icon-button" type="button" aria-label="Cancel tab rename" title="Cancel tab rename" onClick={() => { setRenaming(null); requestAnimationFrame(() => buttons.current.get(active.id)?.focus()); }}><X size={13}/></button></>
          : <button className="icon-button" type="button" aria-label={`Rename ${active.title} tab`} title="Rename tab" onClick={() => beginRename(active.id)}><Pencil size={13}/></button>}
        <button className="icon-button" type="button" aria-label={`Delete ${active.title} tab`} title={documents.length < 2 ? 'Keep at least one tab' : 'Delete tab'} disabled={documents.length < 2 || Boolean(renaming)} onClick={() => active.source.trim() ? setDeleting(active.id) : remove(active.id)}><Trash2 size={13}/></button>
      </div>
    </div>
    {deleting && <div className="source-delete-confirm" role="group" aria-label="Confirm tab deletion"><span>Delete “{documents.find(document => document.id === deleting)?.title}” and its contents?</span><button className="text-button" type="button" onClick={() => remove(deleting)}>Delete</button><button className="text-button" type="button" autoFocus onClick={() => setDeleting(null)}>Cancel</button></div>}
    <div id="workspace-source-panel" className="source-panel" role="tabpanel" aria-labelledby={`source-tab-${active.id}`}>
      <div className="code-editor source-code"><div className="line-numbers" aria-hidden="true" ref={numbers}>{lineNumbers}</div><textarea
        ref={editor} spellCheck={false} wrap="off" aria-label={`${active.title} source`} aria-invalid={Boolean(error)} aria-describedby={error ? 'workspace-source-error' : undefined} value={active.source}
        onChange={event => edit(event.target.value)} onBlur={remember} onSelect={remember}
        onScroll={event => { if (numbers.current) numbers.current.scrollTop = event.currentTarget.scrollTop; remember(); }}
        onKeyDown={event => {
          if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault(); const input = event.currentTarget, start = input.selectionStart, end = input.selectionEnd;
          edit(active.source.slice(0, start) + '  ' + active.source.slice(end));
          requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 2; remember(); });
        }}/></div>
    </div>
    {error && <div id="workspace-source-error" className="source-error" role="alert">{error}</div>}
  </div>;
}
