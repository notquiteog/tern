import type { ReactNode } from 'react';
import { useMediaQuery } from '../lib/hooks';
import { cls } from '../lib/format';

// One list definition, two renderings: a table on wide screens and a stack
// of cards on narrow ones. Columns marked `primary`/`secondary` become the
// card's title and subtitle; `actions` columns move to the card footer;
// `hideOnMobile` columns are dropped there. Everything else renders as
// label/value pairs, skipping empty values.
export interface Column<T> {
  key: string;
  header?: ReactNode;
  cell: (row: T) => ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  primary?: boolean;
  secondary?: boolean;
  actions?: boolean;
  hideOnMobile?: boolean;
  nowrap?: boolean;
  // On cards, span the full width (long values such as DNS records).
  wide?: boolean;
}

export interface Selection<T> { selected: Set<any>; id: (row: T) => any; onToggle: (row: T) => void; onToggleAll?: (all: boolean) => void }

export function DataTable<T>({ columns, rows, rowKey, onRowClick, rowClass, selection, minWidth, breakpoint = '(max-width: 760px)', dense, cardSize }: {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string | number; onRowClick?: (row: T) => void; rowClass?: (row: T) => string | false | undefined;
  selection?: Selection<T>; minWidth?: number; breakpoint?: string; dense?: boolean; cardSize?: 'sm' | 'md';
}) {
  const narrow = useMediaQuery(breakpoint);
  const isEmpty = (v: ReactNode) => v === null || v === undefined || v === false || v === '';
  if (narrow) {
    const primary = columns.find((c) => c.primary) ?? columns.find((c) => !c.actions && !c.hideOnMobile);
    const secondary = columns.find((c) => c.secondary);
    const actions = columns.filter((c) => c.actions);
    const rest = columns.filter((c) => c !== primary && c !== secondary && !c.actions && !c.hideOnMobile);
    return (
      <div className={cls('dt-cards', cardSize === 'sm' && 'dt-cards-sm')}>
        {rows.map((r) => {
          const sel = selection ? selection.selected.has(selection.id(r)) : false;
          const kv = rest.map((c) => [c, c.cell(r)] as const).filter(([, v]) => !isEmpty(v));
          return (
            <div key={rowKey(r)} className={cls('dt-card', onRowClick && 'clickable', sel && 'selected', rowClass?.(r))} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              <div className="dt-card-head">
                {selection && <span className="dt-card-check" onClick={(e) => { e.stopPropagation(); selection.onToggle(r); }}><input type="checkbox" className="checkbox" checked={sel} onChange={() => selection.onToggle(r)} onClick={(e) => e.stopPropagation()} aria-label="Select" /></span>}
                <div className="dt-card-title">{primary?.cell(r)}{secondary && !isEmpty(secondary.cell(r)) && <div className="dt-card-sub">{secondary.cell(r)}</div>}</div>
              </div>
              {kv.length > 0 && <dl className="dt-kv">{kv.map(([c, v]) => <div key={c.key} className={cls(c.wide && 'dt-wide')}>{c.header && <dt>{c.header}</dt>}<dd>{v}</dd></div>)}</dl>}
              {actions.length > 0 && <div className="dt-card-actions" onClick={(e) => e.stopPropagation()}>{actions.map((c) => <span key={c.key}>{c.cell(r)}</span>)}</div>}
            </div>
          );
        })}
      </div>
    );
  }
  const hasHeader = columns.some((c) => c.header) || selection;
  const allSelected = selection && rows.length > 0 && rows.every((r) => selection.selected.has(selection.id(r)));
  return (
    <div className="table-wrap">
      <table className={cls('table', dense && 'table-dense')} style={minWidth ? { minWidth } : undefined}>
        {hasHeader && (
          <thead><tr>
            {selection && <th style={{ width: 36 }}>{selection.onToggleAll && <input type="checkbox" className="checkbox" checked={Boolean(allSelected)} onChange={(e) => selection.onToggleAll!(e.target.checked)} aria-label="Select all" />}</th>}
            {columns.map((c) => <th key={c.key} style={{ width: c.width, textAlign: c.align }}>{c.header}</th>)}
          </tr></thead>
        )}
        <tbody>
          {rows.map((r) => {
            const sel = selection ? selection.selected.has(selection.id(r)) : false;
            return (
              <tr key={rowKey(r)} className={cls(onRowClick && 'clickable', sel && 'selected', rowClass?.(r))} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {selection && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" className="checkbox" checked={sel} onChange={() => selection.onToggle(r)} onClick={(e) => e.stopPropagation()} aria-label="Select" /></td>}
                {columns.map((c) => <td key={c.key} className={cls(c.className, c.nowrap && 'nowrap')} style={{ width: c.width, textAlign: c.align }} onClick={c.actions ? (e) => e.stopPropagation() : undefined}>{c.actions ? <div className="row gap-4" style={{ justifyContent: c.align === 'left' ? 'flex-start' : 'flex-end' }}>{c.cell(r)}</div> : c.cell(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
