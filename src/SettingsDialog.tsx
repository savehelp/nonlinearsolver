import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export type SettingsPane = 'diagnostics' | 'sweep' | 'solver' | 'graph';
const sections: { id: SettingsPane; label: string; title: string }[] = [
  { id: 'diagnostics', label: 'Diagnostics', title: 'Diagnostics' },
  { id: 'sweep', label: 'Sweep', title: 'Sweep settings' },
  { id: 'solver', label: 'Solver', title: 'Solver settings' },
  { id: 'graph', label: 'Graph', title: 'Graph scale' },
];

export default function SettingsDialog({ pane, onPane, onClose, children }: {
  pane: SettingsPane; onPane: (pane: SettingsPane) => void; onClose: () => void; children: ReactNode;
}) {
  return <div className="modal-backdrop" onClick={onClose}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-label={sections.find(section => section.id === pane)!.title} onClick={event => event.stopPropagation()}>
    <div className="modal-heading"><h2>{sections.find(section => section.id === pane)!.title}</h2><button className="icon-button" aria-label="Close settings" onClick={onClose}><X size={20}/></button></div>
    <nav className="settings-nav" aria-label="Settings sections">{sections.map(section => <button key={section.id} type="button" aria-pressed={pane === section.id} onClick={() => onPane(section.id)}>{section.label}</button>)}</nav>
    {children}
  </section></div>;
}
