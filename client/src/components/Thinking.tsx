// Whether the model thinks before it answers, and how hard — as the person's
// own setting rather than the install's.
//
// ── Why the same control appears in several places ──────────────────────────
//
// Because the trade it governs is felt at the moment of use, not in a settings
// screen. Reasoning buys accuracy with latency — roughly seventy seconds a
// draft against under one — and which of those somebody wants depends entirely
// on what they are doing right now. Triaging fifty messages and composing one
// difficult reply are the same person an hour apart.
//
// So there is one component, used compactly beside the AI surfaces and in full
// on the settings page, and all of them write the same preference. A control
// that only existed in Settings would be a control nobody changed.
//
// ── What it does NOT do ─────────────────────────────────────────────────────
//
// Take effect only where it is shown. The preference is applied on the server,
// once, at the two entry points every generation goes through — see
// `ai/thinking.ts`. This component is how it is set, not where it is honoured,
// which is why a surface without the control still obeys it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Check } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { Menu, MenuItem, Segmented, Toggle } from './ui';

export type ThinkingChoice = 'default' | 'off' | 'on';
export type EffortChoice = 'default' | 'low' | 'medium' | 'high';

export interface ThinkingView {
  prefs: { thinking: ThinkingChoice; effort: EffortChoice };
  /** Whether this person's choice counts at all. */
  allowed: boolean;
  installDefault: { thinking: boolean; effort: 'low' | 'medium' | 'high' };
  effective: { thinking: boolean; effort: 'low' | 'medium' | 'high' };
}

export function useThinking(enabled = true) {
  return useQuery({
    queryKey: ['ai-thinking'],
    queryFn: () => api.get<ThinkingView>('/api/ai/thinking'),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useSetThinking() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: Partial<ThinkingView['prefs']>) => api.put<ThinkingView>('/api/ai/thinking', patch),
    onSuccess: (view) => { qc.setQueryData(['ai-thinking'], view); },
    onError: (e) => toast.error(e),
  });
}

const EFFORT_LABEL: Record<EffortChoice, string> = {
  default: 'Server default', low: 'Brief', medium: 'Balanced', high: 'Thorough',
};

/** What the person is actually getting, in one line. */
export function thinkingSummary(v: ThinkingView): string {
  if (!v.effective.thinking) return 'Answers come straight back';
  return `Thinks first · ${EFFORT_LABEL[v.effective.effort as EffortChoice]}`;
}

/**
 * The compact one, for beside an AI surface.
 *
 * Absent rather than disabled when an admin has not enabled personal settings —
 * the same rule the picture button and the assistant button follow. A control
 * that exists only to explain that you may not use it is worse than no control.
 */
export function ThinkingButton({ className }: { className?: string }) {
  const { data } = useThinking();
  const set = useSetThinking();
  if (!data?.allowed) return null;
  const on = data.effective.thinking;
  return (
    <Menu
      align="right"
      width={230}
      trigger={(open, isOpen) => (
        <button
          type="button"
          className={`btn btn-sm ${on ? 'btn-soft' : ''} ${isOpen ? 'active' : ''} ${className ?? ''}`}
          onClick={open}
          title={thinkingSummary(data)}
          aria-label={`Reasoning: ${thinkingSummary(data)}`}
        >
          <Brain size={14} />
          <span className="btn-label">{on ? EFFORT_LABEL[data.effective.effort as EffortChoice] : 'Fast'}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Thinking</div>
          {(['default', 'off', 'on'] as ThinkingChoice[]).map((choice) => (
            <MenuItem
              key={choice}
              active={data.prefs.thinking === choice}
              icon={data.prefs.thinking === choice ? <Check size={14} /> : <span style={{ width: 14 }} />}
              onClick={() => { set.mutate({ thinking: choice }); close(); }}
            >
              {choice === 'default'
                ? `Server default (${data.installDefault.thinking ? 'thinks' : 'straight answer'})`
                : choice === 'off' ? 'Answer straight away' : 'Think first'}
            </MenuItem>
          ))}
          {data.effective.thinking && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">How hard</div>
              {(['default', 'low', 'medium', 'high'] as EffortChoice[]).map((choice) => (
                <MenuItem
                  key={choice}
                  active={data.prefs.effort === choice}
                  icon={data.prefs.effort === choice ? <Check size={14} /> : <span style={{ width: 14 }} />}
                  onClick={() => { set.mutate({ effort: choice }); close(); }}
                >
                  {EFFORT_LABEL[choice]}
                </MenuItem>
              ))}
            </>
          )}
          <div className="menu-sep" />
          <div className="menu-note">Applies to every AI feature that runs in your name, not just this one — including replies sent while you are away.</div>
        </>
      )}
    </Menu>
  );
}

/**
 * The full one, for the settings page.
 *
 * Shown even when the person may not change it, unlike the compact button. A
 * settings screen is the one place where "an administrator decides this for
 * you" is an answer somebody came looking for, rather than a dead end they
 * bumped into mid-task.
 */
export function ThinkingCard() {
  const { data } = useThinking();
  const set = useSetThinking();
  if (!data) return null;
  const chosen = data.prefs.thinking !== 'default' || data.prefs.effort !== 'default';
  return (
    <div className="card mb-16">
      <div className="card-title">
        <h2>Thinking</h2>
        <span className="small muted">{thinkingSummary(data)}</span>
      </div>
      <p className="muted small">
        Some models work a problem through before answering. It makes them noticeably more accurate on
        anything fiddly — following a format, judging whether a message needs a reply — and noticeably
        slower: on this server, the difference is roughly seventy seconds against under one. Which of
        those you want depends on what you are doing, so it is yours to set.
      </p>
      {!data.allowed ? (
        <div className="help-text">
          An administrator has not enabled personal reasoning settings on this server, so everyone gets
          the server&rsquo;s own: <b>{data.installDefault.thinking ? `thinks first (${EFFORT_LABEL[data.installDefault.effort]})` : 'answers straight away'}</b>.
          {chosen && <> You chose something different while it was allowed; that choice is saved and will
          apply again if an administrator turns personal settings back on.</>}
        </div>
      ) : (
        <>
          <div className="row mb-8">
            <Toggle
              checked={data.prefs.thinking === 'default'}
              onChange={(v) => set.mutate({ thinking: v ? 'default' : (data.installDefault.thinking ? 'on' : 'off') })}
              label="Follow the server default"
            />
            <span className="small">
              The server currently {data.installDefault.thinking ? `thinks first (${EFFORT_LABEL[data.installDefault.effort]})` : 'answers straight away'}
            </span>
          </div>
          {data.prefs.thinking !== 'default' && (
            <div className="row mb-8">
              <Segmented
                value={data.prefs.thinking}
                onChange={(v) => set.mutate({ thinking: v })}
                options={[{ value: 'off' as const, label: 'Answer straight away' }, { value: 'on' as const, label: 'Think first' }]}
              />
            </div>
          )}
          {data.effective.thinking && (
            <div className="row">
              <span className="small" style={{ minWidth: 80 }}>How hard</span>
              <Segmented
                value={data.prefs.effort}
                onChange={(v) => set.mutate({ effort: v })}
                options={[
                  { value: 'default' as const, label: 'Server default' },
                  { value: 'low' as const, label: 'Brief' },
                  { value: 'medium' as const, label: 'Balanced' },
                  { value: 'high' as const, label: 'Thorough' },
                ]}
              />
            </div>
          )}
          <div className="help-text mt-8">
            Applies to everything the model does <b>on your behalf</b> — drafts, replies, summaries, the
            daily brief, rules described out loud, conversations with the assistant, and the automatic
            replies and sequences that run in your name while you are away. Work done for somebody else
            uses their setting, not yours.
          </div>
        </>
      )}
    </div>
  );
}
