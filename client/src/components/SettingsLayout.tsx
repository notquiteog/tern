import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cls } from '../lib/format';

// The frame both settings areas sit in — yours under /settings, the whole
// install's under /admin.
//
// It used to be a single row of tabs. Eleven of them. A row of tabs is a fine
// shape for four things and a bad one for eleven: past the width of the pane
// the rest are simply off the edge, and the only clue that Security and
// Encryption exist at all is that the row happens to scroll. Nobody scrolls a
// tab strip sideways looking for a page they do not know is there.
//
// So: a column. Grouped, because "Profile" and "Security" are the same kind of
// question and "Appearance" is not, and every entry is on the screen at once.
// Where the pane is too narrow for a column beside the content — a phone, a
// half-width window, a tablet in portrait — the same list becomes a disclosure
// that names where you are and opens to the full set. Nothing is ever only
// reachable by scrolling something sideways.

export interface SettingsSection {
  key: string;
  label: string;
  icon: ReactNode;
  /** One line under the label in the open list; skipped in the rail. */
  hint?: string;
}
export interface SettingsGroup {
  title: string;
  items: SettingsSection[];
}

export function SettingsLayout({ title, badge, sub, action, base, groups, children }: {
  title: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
  /** The one link out of here: Admin settings, or back to My settings. */
  action?: ReactNode;
  /** Route prefix the section keys hang off, e.g. `/settings`. */
  base: string;
  groups: SettingsGroup[];
  children: ReactNode;
}) {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  // Picking a section closes the list; it has done its job and the content
  // below it is what you came for.
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const all = groups.flatMap((g) => g.items);
  const current = all.find((s) => loc.pathname === `${base}/${s.key}` || loc.pathname.startsWith(`${base}/${s.key}/`));

  return (
    <div className="page settings-page">
      <div className="settings-shell">
        <header className="settings-masthead">
          <div className="settings-masthead-text">
            <h1>{title}{badge}</h1>
            {sub && <div className="sub">{sub}</div>}
          </div>
          {action && <div className="settings-masthead-action">{action}</div>}
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" data-open={open ? 'yes' : 'no'} aria-label="Settings sections">
            {/* Only drawn where the rail does not fit; the rail itself is the
                same list with the disclosure taken off the front. */}
            <button
              type="button"
              className="settings-nav-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="settings-nav-toggle-icon">{current?.icon}</span>
              <span className="settings-nav-toggle-text">
                <span className="settings-nav-toggle-label">{current?.label ?? 'Sections'}</span>
                <span className="settings-nav-toggle-hint">{open ? 'Pick a section' : `Change section · ${all.length} in total`}</span>
              </span>
              <ChevronDown size={16} className={cls('settings-nav-caret', open && 'up')} />
            </button>

            <div className="settings-nav-list">
              {groups.map((g) => (
                <div key={g.title} className="settings-nav-group">
                  <div className="settings-nav-group-title">{g.title}</div>
                  {g.items.map((s) => (
                    <NavLink
                      key={s.key}
                      to={`${base}/${s.key}`}
                      className={({ isActive }) => cls('settings-nav-item', isActive && 'active')}
                    >
                      <span className="settings-nav-icon">{s.icon}</span>
                      <span className="settings-nav-text">
                        <span className="settings-nav-label">{s.label}</span>
                        {s.hint && <span className="settings-nav-hint">{s.hint}</span>}
                      </span>
                    </NavLink>
                  ))}
                </div>
              ))}
            </div>
          </nav>

          <div className="settings-pane">{children}</div>
        </div>
      </div>
    </div>
  );
}
