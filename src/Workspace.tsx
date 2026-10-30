import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';

const STORAGE = 'node-panel-layout-v1';
const defaults = { editor: 29, parameters: 18, editorCollapsed: false, parametersCollapsed: false };
type Layout = typeof defaults;
type Axis = 'editor' | 'parameters';
function initialLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    if (saved && Number.isFinite(saved.editor) && Number.isFinite(saved.parameters)) return {
      editor: Math.max(5, Math.min(95, saved.editor)), parameters: Math.max(5, Math.min(95, saved.parameters)),
      editorCollapsed: saved.editorCollapsed === true, parametersCollapsed: saved.parametersCollapsed === true,
    };
  } catch { /* Use default panel sizes when browser storage is unavailable. */ }
  return defaults;
}

export default function Workspace({ children }: { children: ReactNode }) {
  const [layout, setLayout] = useState(initialLayout);
  const [dragging, setDragging] = useState<Axis | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ axis: Axis; pointer: number; offset: number } | null>(null);
  const limits = (axis: Axis) => {
    const rect = container.current?.getBoundingClientRect();
    const size = axis === 'editor' ? rect?.width ?? 1200 : rect?.height ?? 800;
    return axis === 'editor' ? { min: Math.min(260 / size * 100, 40), max: Math.max(60, 100 - 380 / size * 100) } : { min: Math.min(96 / size * 100, 25), max: Math.max(40, 100 - 300 / size * 100) };
  };
  const resize = (axis: Axis, value: number) => {
    const { min, max } = limits(axis);
    setLayout(current => {
      const next = { ...current, [axis]: Math.max(min, Math.min(max, value)) };
      try { localStorage.setItem(STORAGE, JSON.stringify(next)); } catch { /* Resizing still works without storage. */ }
      return next;
    });
  };
  const start = (event: PointerEvent<HTMLDivElement>, axis: Axis) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const rect = container.current!.getBoundingClientRect();
    const position = axis === 'editor' ? rect.left + rect.width * layout.editor / 100 : rect.bottom - rect.height * layout.parameters / 100;
    drag.current = { axis, pointer: event.pointerId, offset: (axis === 'editor' ? event.clientX : event.clientY) - position }; setDragging(axis);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || event.pointerId !== drag.current.pointer) return;
    const rect = container.current!.getBoundingClientRect(), { axis, offset } = drag.current;
    resize(axis, axis === 'editor' ? (event.clientX - offset - rect.left) / rect.width * 100 : (rect.bottom - event.clientY + offset) / rect.height * 100);
  };
  const stop = () => { drag.current = null; setDragging(null); };
  const toggle = (axis: Axis) => {
    stop();
    const key = axis === 'editor' ? 'editorCollapsed' : 'parametersCollapsed';
    setLayout(current => {
      const next = { ...current, [key]: !current[key] };
      try { localStorage.setItem(STORAGE, JSON.stringify(next)); } catch { /* Toggling still works without storage. */ }
      return next;
    });
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>, axis: Axis) => {
    const positive = axis === 'editor' ? 'ArrowRight' : 'ArrowUp', negative = axis === 'editor' ? 'ArrowLeft' : 'ArrowDown';
    if (![positive, negative, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resize(axis, event.key === 'Home' ? limits(axis).min : event.key === 'End' ? limits(axis).max : layout[axis] + (event.key === positive ? 1 : -1) * (event.shiftKey ? 5 : 1));
  };
  return <div ref={container} className={`workspace-grid ${layout.editorCollapsed ? 'editor-collapsed' : ''} ${layout.parametersCollapsed ? 'parameters-collapsed' : ''} ${dragging ? `resizing resizing-${dragging}` : ''}`} style={{ '--editor-size': layout.editorCollapsed ? '26px' : `${layout.editor}%`, '--parameter-size': layout.parametersCollapsed ? '26px' : `${layout.parameters}%` } as CSSProperties}>
    {children}
    {(['editor', 'parameters'] as const).map(axis => {
      const collapsed = axis === 'editor' ? layout.editorCollapsed : layout.parametersCollapsed;
      return <div key={axis} className={`panel-divider divider-${axis}`} role="separator" tabIndex={collapsed ? -1 : 0} aria-hidden={collapsed} aria-label={axis === 'editor' ? 'Resize equations and graph' : 'Resize parameters and upper panels'} aria-orientation={axis === 'editor' ? 'vertical' : 'horizontal'} aria-valuemin={Math.round(limits(axis).min)} aria-valuemax={Math.round(limits(axis).max)} aria-valuenow={Math.round(layout[axis])} aria-valuetext={`${Math.round(layout[axis])}% ${axis === 'editor' ? 'equations width' : 'parameters height'}`} title="Drag to resize · double-click to reset" onPointerDown={event => start(event, axis)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => keyboard(event, axis)} onDoubleClick={() => resize(axis, defaults[axis])} />;
    })}
    <button type="button" className="panel-collapse-toggle toggle-editor" aria-label={layout.editorCollapsed ? 'Expand equation sidebar' : 'Collapse equation sidebar'} title={layout.editorCollapsed ? 'Expand equation sidebar' : 'Collapse equation sidebar'} aria-expanded={!layout.editorCollapsed} onClick={() => toggle('editor')}>
      {layout.editorCollapsed ? <ChevronRight size={15}/> : <ChevronLeft size={15}/>} {layout.editorCollapsed && <span>Editor</span>}
    </button>
    <button type="button" className="panel-collapse-toggle toggle-parameters" aria-label={layout.parametersCollapsed ? 'Expand slider bar' : 'Collapse slider bar'} title={layout.parametersCollapsed ? 'Expand slider bar' : 'Collapse slider bar'} aria-expanded={!layout.parametersCollapsed} onClick={() => toggle('parameters')}>
      {layout.parametersCollapsed ? <ChevronUp size={15}/> : <ChevronDown size={15}/>} {layout.parametersCollapsed && <span>Sliders</span>}
    </button>
  </div>;
}
