// Ctrl+K, as a way to reach your things rather than a menu of pages.
//
// What was here before was thirty hard-coded destinations filtered by
// substring: "Go to Inbox", "Settings: Security". Useful, and about a tenth
// of what the app could already answer. Tern can search contacts, templates,
// sequences, the mail itself, the meaning index and the commitments ledger —
// none of which the palette could see. Typing a person's name got you
// nothing, because no destination is called that.
//
// So the palette asks everything the account has turned on, and shows the
// answers in groups. Three rules keep it from becoming a mess:
//
//   Exact before inferred. Commands and names match instantly off data the
//   browser already holds. Mail search is exact. The meaning index answers
//   last and sits at the bottom under its own heading, the same bargain the
//   omnibox strikes — a precise answer is never displaced by a plausible one.
//
//   A group with nothing in it is not drawn. No empty headings, no "0
//   results" rows, no layout that jumps as each search lands.
//
//   Nothing here reads anything the person has not turned on. Every async
//   source is behind its capability, so an account with the optional features
//   off gets exactly the palette it had before, plus the things that were
//   always local.
//
// The verbs at the top when a conversation is open are the other half of it.
// Reading a thread and wanting to archive it is the single most common thing
// anyone does in this app, and the palette used to be the one place you could
// not do it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, ClipboardCheck, Contact, Inbox, Mail, Search, Send, Settings, Sparkles, Star, Telescope, Trash2, Workflow, Wrench, Clock, Bot, ListFilter, Home, FileText, Newspaper, KeyRound, Palette, Moon, Upload, Plus, ShieldCheck, MailOpen, AlarmClock, Users, VenetianMask, Reply } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { useCompose } from '../state/compose';
import { useFeatures } from '../state/features';
import { useAssistant } from '../state/assistant';
import { useToast } from '../state/toast';
import { setAppearance } from '../state/theme';
import { cls, fmtDate } from '../lib/format';
import type { SemanticHit } from './SearchExtras';

interface Item {
  id: string;
  group: string;
  label: string;
  /** The second line, where there is one worth having. */
  sub?: string;
  icon?: ReactNode;
  hint?: string;
  run: () => void;
}

// Groups in the order they are drawn. "Meaning" is last on purpose.
const GROUP_ORDER = ['This conversation', 'Actions', 'Mail', 'People', 'Templates', 'Sequences', 'Commitments', 'Go to', 'Meaning'] as const;

// How long to wait before asking the server. Local sources are filtered
// in memory and need no delay at all; the two that cost something get one,
// and the meaning index gets the longer one because it is priced in work.
const SEARCH_DEBOUNCE = 180;
const SEMANTIC_DEBOUNCE = 450;

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

// The conversation currently open, read off the route rather than passed in.
// The palette lives in the shell, above the router outlet, so this is the
// only way it can know — and it means every route that opens a thread gets
// the verbs for free.
function openThread(pathname: string): { accountId: number; threadId: string } | null {
  const m = /\/mail\/[^/]+\/t\/([^/]+)/.exec(pathname);
  if (!m) return null;
  const key = decodeURIComponent(m[1]);
  const at = key.indexOf(':');
  if (at < 1) return null;
  const accountId = Number(key.slice(0, at));
  if (!Number.isFinite(accountId)) return null;
  return { accountId, threadId: key.slice(at + 1) };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const compose = useCompose();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { can } = useFeatures();
  const assistant = useAssistant();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const term = q.trim();
  const debounced = useDebounced(term, SEARCH_DEBOUNCE);
  const semanticTerm = useDebounced(term, SEMANTIC_DEBOUNCE);

  const [contacts, setContacts] = useState<any[]>([]);
  const [threads, setThreads] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [sequences, setSequences] = useState<any[]>([]);
  const [commitments, setCommitments] = useState<any[]>([]);
  const [meaning, setMeaning] = useState<SemanticHit[]>([]);

  const thread = openThread(loc.pathname);

  // ---------- The always-there half ----------

  const commands = useMemo<Item[]>(() => {
    const go = (label: string, to: string, icon: ReactNode, hint?: string): Item =>
      ({ id: `go:${to}:${label}`, group: 'Go to', label, icon, hint, run: () => nav(to) });
    return [
      { id: 'act:compose', group: 'Actions', label: 'Compose new message', icon: <Send size={15} />, hint: 'c', run: () => compose.open() },
      { id: 'act:import', group: 'Actions', label: 'Import contacts from CSV', icon: <Upload size={15} />, run: () => nav('/contacts?import=1') },
      { id: 'act:newseq', group: 'Actions', label: 'New sequence', icon: <Plus size={15} />, run: () => nav('/sequences?new=1') },
      { id: 'act:campaign', group: 'Actions', label: 'New AI campaign', icon: <Sparkles size={15} />, run: () => nav('/sequences?campaign=1') },
      { id: 'act:dark', group: 'Actions', label: 'Toggle dark mode', icon: <Moon size={15} />, run: () => setAppearance({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
      ...(can('ai.assistant') ? [{ id: 'act:assistant', group: 'Actions', label: 'Ask the assistant', icon: <Bot size={15} />, hint: '⌘J', run: () => assistant.show() } as Item] : []),

      go('Inbox', '/mail/inbox', <Inbox size={15} />, 'g i'),
      go('Starred', '/mail/starred', <Star size={15} />, 'g s'),
      go('Snoozed', '/mail/snoozed', <AlarmClock size={15} />),
      go('Sent', '/mail/sent', <Send size={15} />, 'g t'),
      go('Drafts', '/mail/drafts', <FileText size={15} />, 'g d'),
      go('Scheduled sends', '/mail/scheduled', <Clock size={15} />),
      go('Archive', '/mail/archive', <Archive size={15} />),
      go('Junk', '/mail/junk', <ShieldCheck size={15} />),
      go('Trash', '/mail/trash', <Trash2 size={15} />),
      go('Burner address', '/mail/burner', <VenetianMask size={15} />),
      go('All mail', '/mail/all', <Mail size={15} />, 'g a'),
      go('Overview', '/home', <Home size={15} />, 'g h'),
      go('Contacts', '/contacts', <Contact size={15} />, 'g c'),
      go('Sequences', '/sequences', <Workflow size={15} />, 'g q'),
      go('Templates', '/templates', <BookOpen size={15} />),
      go('AI review queue', '/review', <Sparkles size={15} />, 'g r'),
      go('Campaign replies', '/sequences/replies', <Reply size={15} />),
      go('AI responders', '/responders', <Bot size={15} />),
      go('Inbox rules', '/rules', <ListFilter size={15} />),
      ...(can('brief') ? [go('Brief', '/brief', <Newspaper size={15} />)] : []),
      ...(can('commitments') ? [go('Commitments', '/commitments', <ClipboardCheck size={15} />)] : []),
      go('Settings: Accounts', '/settings/accounts', <Settings size={15} />),
      go('Settings: Features', '/settings/features', <Settings size={15} />),
      go('Settings: AI assistant', '/settings/ai', <Sparkles size={15} />),
      go('Settings: Security', '/settings/security', <KeyRound size={15} />),
      go('Settings: Appearance', '/settings/appearance', <Palette size={15} />),
      go('Settings: Profile picture', '/settings/profile', <Contact size={15} />),
      go('Settings: Encryption and Autocrypt', '/settings/encryption', <KeyRound size={15} />),
      go('Settings: Mail apps and mailbox password', '/settings/mailapps', <Mail size={15} />),
      ...(user?.role === 'admin' ? [
        go('Admin: Users and sign-up', '/admin/users', <Users size={15} />),
        go('Admin: Mail server', '/admin/mailserver', <Wrench size={15} />),
        go('Admin: AI model', '/admin/ai', <Sparkles size={15} />),
        go('Admin: Features', '/admin/features', <Wrench size={15} />),
        go('Admin: Branding', '/admin/branding', <Palette size={15} />),
        go('Admin: Audit log', '/admin/audit', <FileText size={15} />),
        go('Admin: General', '/admin/general', <Wrench size={15} />),
      ] : []),
    ];
  }, [nav, compose, user?.role, can]);

  // ---------- Verbs for the conversation being read ----------

  const threadVerbs = useMemo<Item[]>(() => {
    if (!thread) return [];
    // Where the list is, worked out from the route the thread is on rather
    // than from history: going "back" after archiving should land on the
    // mailbox you were reading, which is not necessarily the last page you
    // were on.
    const list = `${loc.pathname.replace(/\/t\/[^/]+.*$/, '')}${loc.search}`;
    const act = async (action: string, msg: string, extra: Record<string, unknown> = {}) => {
      try {
        await api.post('/api/mail/actions', { accountId: thread.accountId, threadIds: [thread.threadId], action, ...extra });
        qc.invalidateQueries({ queryKey: ['threads'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
        qc.invalidateQueries({ queryKey: ['thread', thread.accountId, thread.threadId] });
        toast.success(msg);
      } catch (e) { toast.error(e); }
    };
    const verb = (label: string, icon: ReactNode, run: () => void, hint?: string): Item =>
      ({ id: `t:${label}`, group: 'This conversation', label, icon, hint, run });
    return [
      verb('Archive this conversation', <Archive size={15} />, () => { void act('archive', 'Archived'); nav(list); }, 'e'),
      verb('Star this conversation', <Star size={15} />, () => void act('star', 'Starred'), 's'),
      verb('Mark as unread', <MailOpen size={15} />, () => void act('unread', 'Marked unread'), 'U'),
      verb('Move to junk', <ShieldCheck size={15} />, () => { void act('spam', 'Marked as junk'); nav(list); }, '!'),
      verb('Move to trash', <Trash2 size={15} />, () => { void act('trash', 'Moved to trash'); nav(list); }, '#'),
      verb('Mute this conversation', <ListFilter size={15} />, () => void act('mute', 'Muted')),
    ];
  }, [thread, qc, toast, nav, loc.pathname, loc.search]);

  // ---------- The searched half ----------

  // Local lists. Cheap enough to fetch once each time the palette opens, and
  // fetching on open rather than on keystroke means the first character typed
  // already has something to match against.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.get<{ templates: any[] }>('/api/templates').then((r) => { if (live) setTemplates(r.templates); }).catch(() => {});
    api.get<{ sequences: any[] }>('/api/sequences').then((r) => { if (live) setSequences(r.sequences); }).catch(() => {});
    if (can('commitments')) {
      api.get<{ commitments: any[] }>('/api/assist/commitments')
        .then((r) => { if (live) setCommitments(r.commitments ?? []); }).catch(() => {});
    }
    return () => { live = false; };
  }, [open, can]);

  // Contacts and mail, which need the server to do the matching.
  useEffect(() => {
    if (!open || debounced.length < 2) { setContacts([]); setThreads([]); return; }
    let live = true;
    api.get<{ contacts: any[] }>(`/api/contacts?q=${encodeURIComponent(debounced)}&size=10`)
      .then((r) => { if (live) setContacts(r.contacts ?? []); }).catch(() => { if (live) setContacts([]); });
    api.get<{ threads: any[] }>(`/api/mail/threads?box=all&accounts=all&q=${encodeURIComponent(debounced)}&page=1&f=`)
      .then((r) => { if (live) setThreads((r.threads ?? []).slice(0, 5)); }).catch(() => { if (live) setThreads([]); });
    return () => { live = false; };
  }, [open, debounced]);

  // The meaning index, which costs work and answers last.
  useEffect(() => {
    if (!open || !can('semantic') || semanticTerm.length < 3) { setMeaning([]); return; }
    let live = true;
    // Deliberately the plain endpoint rather than the work-priced helper: a
    // palette that made the browser hash for a few hundred milliseconds on
    // every pause in typing would be a palette that feels broken. The guard
    // still prices it server-side if the pace is unreasonable.
    api.post<{ hits: SemanticHit[] }>('/api/discover/search', { q: semanticTerm, limit: 5 })
      .then((r) => { if (live) setMeaning(r.hits ?? []); }).catch(() => { if (live) setMeaning([]); });
    return () => { live = false; };
  }, [open, semanticTerm, can]);

  // ---------- Assembling ----------

  const items = useMemo<Item[]>(() => {
    const lower = term.toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(lower);
    const out: Item[] = [];

    // With nothing typed the palette is the verbs for what is on screen and
    // the things you might start. A wall of every destination is not an
    // answer to an empty box.
    if (!term) {
      out.push(...threadVerbs);
      out.push(...commands.filter((c) => c.group === 'Actions'));
      out.push(...commands.filter((c) => c.group === 'Go to').slice(0, 8));
      return out;
    }

    out.push(...threadVerbs.filter((v) => match(v.label)));
    out.push(...commands.filter((c) => c.group === 'Actions' && match(c.label)));

    for (const t of threads) {
      const from = t.latest?.from?.[0];
      out.push({
        id: `mail:${t.account_id}:${t.thread_id}`,
        group: 'Mail',
        label: t.latest?.subject || '(no subject)',
        sub: `${from?.name || from?.email || 'Unknown sender'}${t.latest?.received_at ? ` · ${fmtDate(t.latest.received_at)}` : ''}`,
        icon: <Mail size={15} />,
        run: () => nav(`/mail/all/t/${encodeURIComponent(`${t.account_id}:${t.thread_id}`)}`),
      });
    }

    for (const c of contacts) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email;
      out.push({
        id: `contact:${c.id}`,
        group: 'People',
        label: name,
        sub: [c.email, c.company].filter(Boolean).join(' · '),
        icon: <Contact size={15} />,
        run: () => nav(`/contacts/${c.id}`),
      });
    }

    for (const t of templates.filter((x) => match(x.name) || match(x.subject ?? '') || match(x.category ?? '')).slice(0, 5)) {
      out.push({
        id: `tpl:${t.id}`,
        group: 'Templates',
        label: t.name,
        sub: [t.category, t.subject].filter(Boolean).join(' · '),
        icon: <BookOpen size={15} />,
        run: () => nav('/templates'),
      });
    }

    for (const s of sequences.filter((x) => match(x.name)).slice(0, 5)) {
      out.push({
        id: `seq:${s.id}`,
        group: 'Sequences',
        label: s.name,
        sub: `${s.status}${s.step_count ? ` · ${s.step_count} step${s.step_count === 1 ? '' : 's'}` : ''}`,
        icon: <Workflow size={15} />,
        run: () => nav(`/sequences/${s.id}`),
      });
    }

    for (const c of commitments.filter((x) => match(x.text) || match(x.counterparty ?? '')).slice(0, 5)) {
      out.push({
        id: `commit:${c.id}`,
        group: 'Commitments',
        label: c.text,
        sub: `${c.kind === 'owed' ? 'You owe' : 'Waiting on'}${c.counterparty ? ` · ${c.counterparty}` : ''}`,
        icon: <ClipboardCheck size={15} />,
        // Straight to the conversation it came from where there is one: the
        // ledger row is a pointer, and the useful destination is the mail.
        run: () => nav(c.threadId ? `/mail/all/t/${encodeURIComponent(`${c.accountId}:${c.threadId}`)}` : '/commitments'),
      });
    }

    out.push(...commands.filter((c) => c.group === 'Go to' && match(c.label)));

    // Always offered, always last of the exact answers: the full search for
    // what was typed, for when none of the five rows above is the one.
    out.push({
      id: 'search:all',
      group: 'Mail',
      label: `Search all mail for "${term}"`,
      icon: <Search size={15} />,
      run: () => nav(`/mail/all?q=${encodeURIComponent(term)}`),
    });

    // The other thing a palette full of words can be: a question.
    //
    // It sits after the exact answers and before the inferred ones, which is
    // the same bargain the meaning rows strike — a row that costs a generation
    // never displaces one that costs a lookup. Offered only for something that
    // reads like a question, because "dana" is a name to look up and "what did
    // dana say about the invoice" is not.
    if (can('ai.assistant') && looksLikeAQuestion(term)) {
      out.push({
        id: 'assistant:ask',
        group: 'Assistant',
        label: `Ask the assistant: “${term}”`,
        sub: 'It can search your mail, read a conversation and draft a reply',
        icon: <Bot size={15} />,
        run: () => assistant.show(term),
      });
    }

    for (const h of meaning.filter((h) => !threads.some((t) => t.thread_id === h.threadId))) {
      out.push({
        id: `sem:${h.emailId}`,
        group: 'Meaning',
        label: h.subject || '(no subject)',
        sub: `${h.from?.name || h.from?.email || 'Unknown sender'}${h.receivedAt ? ` · ${fmtDate(h.receivedAt)}` : ''}`,
        icon: <Telescope size={15} />,
        run: () => nav(`/mail/all/t/${encodeURIComponent(`${h.accountId}:${h.threadId}`)}`),
      });
    }

    return out;
  }, [term, threadVerbs, commands, threads, contacts, templates, sequences, commitments, meaning, nav, can, assistant]);

  // Grouped for drawing, still one flat list for the keyboard: arrowing down
  // walks past a heading rather than stopping on it.
  const groups = useMemo(() => {
    const by = new Map<string, Item[]>();
    for (const i of items) {
      const g = by.get(i.group);
      if (g) g.push(i); else by.set(i.group, [i]);
    }
    return [...by.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0] as never) - GROUP_ORDER.indexOf(b[0] as never));
  }, [items]);

  useEffect(() => { setIdx(0); }, [term, open]);
  useEffect(() => { if (!open) { setQ(''); setMeaning([]); setThreads([]); setContacts([]); } }, [open]);
  // Keep the highlighted row in view when it was moved by the keyboard.
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  const run = (i: Item) => { onClose(); i.run(); };
  const move = (d: number) => setIdx((n) => Math.max(0, Math.min(items.length - 1, n + d)));

  let n = -1;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={thread ? 'Search, or act on this conversation…' : 'Search your mail, people and work…'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
              if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
              if (e.key === 'Enter' && items[idx]) { e.preventDefault(); run(items[idx]); }
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {groups.map(([group, rows]) => (
            <div key={group} className="palette-group">
              <div className="palette-group-title">{group}</div>
              {rows.map((i) => {
                n += 1;
                const mine = n;
                return (
                  <div
                    key={i.id}
                    className={cls('palette-item', mine === idx && 'active')}
                    onMouseEnter={() => setIdx(mine)}
                    onClick={() => run(i)}
                  >
                    <span className="palette-icon">{i.icon}</span>
                    <span className="palette-text">
                      <span className="palette-label">{i.label}</span>
                      {i.sub && <span className="palette-sub">{i.sub}</span>}
                    </span>
                    {i.hint && <span className="hint">{i.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {!items.length && <div className="palette-item faint">Nothing matches “{term}”.</div>}
        </div>
      </div>
    </div>
  );
}


/**
 * Whether what was typed is a question rather than a name.
 *
 * The palette is mostly used to jump somewhere, and offering to spend a
 * generation on every two-letter fragment somebody types on the way to their
 * inbox would be both expensive and noisy. So the assistant row appears for
 * things that look like they want an answer: several words, or an opening
 * question word, or a question mark.
 *
 * Deliberately loose in the permissive direction. A false positive is one
 * extra row the person ignores; a false negative is a feature they never find.
 */
export function looksLikeAQuestion(term: string): boolean {
  const t = term.trim();
  if (t.length < 6) return false;
  if (t.includes('?')) return true;
  if (/^(what|who|when|where|why|how|which|is|are|do|does|did|can|could|should|would|will|draft|write|reply|summar|find|show|tell|remind)\b/i.test(t)) return true;
  // Four words is a sentence rather than a name; three is "dana okafor invoice".
  return t.split(/\s+/).length >= 4;
}
