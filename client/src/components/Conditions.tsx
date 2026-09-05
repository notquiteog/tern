import { Plus, X } from 'lucide-react';
import { Button, IconButton, Input, Select } from './ui';

export interface Condition { field: string; op: string; value?: string }
export const CONDITION_FIELDS = [['from', 'From'], ['to', 'To'], ['cc', 'Cc'], ['subject', 'Subject'], ['body', 'Body'], ['any', 'Anywhere'], ['list', 'Mailing list header'], ['has_attachment', 'Has attachment']];
export const CONDITION_OPS = [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is exactly'], ['starts_with', 'starts with'], ['ends_with', 'ends with'], ['matches', 'matches regex']];

// Shared by inbox rules and AI responders so both speak the same language.
export function ConditionsEditor({ conditions, onChange, match, onMatchChange, emptyHint }: { conditions: Condition[]; onChange: (c: Condition[]) => void; match: 'all' | 'any'; onMatchChange: (m: 'all' | 'any') => void; emptyHint?: string }) {
  const set = (i: number, patch: Partial<Condition>) => onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div>
      <div className="row mb-8 small muted">
        <span>When</span>
        <select className="select input-sm" style={{ width: 80 }} value={match} onChange={(e) => onMatchChange(e.target.value as any)}><option value="all">all</option><option value="any">any</option></select>
        <span>of these match{conditions.length === 0 && emptyHint ? <span className="faint"> · {emptyHint}</span> : ''}</span>
      </div>
      {conditions.map((c, i) => (
        <div key={i} className="row mb-8">
          <Select className="input-sm" style={{ width: 170 }} value={c.field} onChange={(e) => set(i, { field: e.target.value, op: e.target.value === 'has_attachment' ? 'is_true' : c.op === 'is_true' || c.op === 'is_false' ? 'contains' : c.op })}>{CONDITION_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          {c.field === 'has_attachment' ? (
            <Select className="input-sm" style={{ width: 120 }} value={c.op} onChange={(e) => set(i, { op: e.target.value })}><option value="is_true">yes</option><option value="is_false">no</option></Select>
          ) : (
            <>
              <Select className="input-sm" style={{ width: 170 }} value={c.op} onChange={(e) => set(i, { op: e.target.value })}>{CONDITION_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Input className="input-sm" value={c.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} placeholder={c.field === 'from' ? 'newsletter@ or @example.com' : 'text'} />
            </>
          )}
          <IconButton label="Remove" className="btn-sm" onClick={() => onChange(conditions.filter((_, j) => j !== i))}><X size={14} /></IconButton>
        </div>
      ))}
      <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...conditions, { field: 'subject', op: 'contains', value: '' }])}>Add condition</Button>
    </div>
  );
}
