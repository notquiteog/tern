import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useCompose, type ComposeWindow } from '../state/compose';
import { IconButton } from './ui';
import { Composer } from './Composer';
import { cls } from '../lib/format';

// The dock in the bottom-right corner: up to three compose windows, Gmail
// style, each one an independent Composer.
export function ComposeDock() {
  const { windows } = useCompose();
  if (!windows.length) return null;
  return <div className="compose-dock">{windows.map((w) => <ComposeWin key={w.key} win={w} />)}</div>;
}

const TITLES: Record<string, string> = { new: 'New message', reply: 'Reply', reply_all: 'Reply all', forward: 'Forward' };

function ComposeWin({ win }: { win: ComposeWindow }) {
  const { close, update } = useCompose();
  const title = win.subject || TITLES[win.kind ?? 'new'];
  if (win.minimized) {
    return (
      <div className="compose-win minimized" onClick={() => update(win.key, { minimized: false })}>
        <div className="compose-head"><span className="truncate flex-1">{title}</span><IconButton label="Restore" onClick={(e) => { e.stopPropagation(); update(win.key, { minimized: false }); }}><Maximize2 size={14} /></IconButton></div>
      </div>
    );
  }
  return (
    <div className={cls('compose-win', win.maximized && 'maximized')}>
      <Composer
        seed={win}
        variant="window"
        onClose={() => close(win.key)}
        onEscape={() => update(win.key, { minimized: true })}
        onDraftId={(id) => update(win.key, { draftId: id })}
        header={({ close, subject, kind }) => (
          <div className="compose-head" onDoubleClick={() => update(win.key, { maximized: !win.maximized })}>
            <span className="truncate flex-1">{subject || TITLES[kind]}</span>
            <IconButton label="Minimize" onClick={() => { update(win.key, { minimized: true, subject }); }}><Minus size={15} /></IconButton>
            <IconButton label={win.maximized ? 'Restore' : 'Maximize'} onClick={() => update(win.key, { maximized: !win.maximized })}>{win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton>
            <IconButton label="Close (keeps the draft)" onClick={close}><X size={16} /></IconButton>
          </div>
        )}
      />
    </div>
  );
}
