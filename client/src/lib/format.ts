export interface Addr { name?: string | null; email: string }

export function addrName(a?: Addr | null): string {
  if (!a) return '';
  return (a.name && a.name.trim()) || a.email?.split('@')[0] || '';
}
export function addrFull(a?: Addr | null): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function initials(s: string): string {
  const parts = s.replace(/[<>"]/g, '').trim().split(/[\s.@_-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Initials are drawn in white, so every colour here has to be dark enough to
// carry white text at 4.5:1 once the avatar's own highlight has lightened it.
// The previous set was picked for vibrancy alone and several were far under —
// white on the amber came out at about 2.7:1.
const PALETTE = ['#3f51c9', '#b62a4c', '#96590f', '#156b47', '#6a34c4', '#0b6b7c', '#9b1fa0', '#a24d09', '#0a7052', '#b32f27', '#4740b8', '#0e6b64'];
export function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function fmtDate(v: string | Date | null | undefined, opts: { always?: boolean } = {}): string {
  if (!v) return '';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay && !opts.always) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
}
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '';
  const d = typeof v === 'string' ? new Date(v) : v;
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return '';
  const d = typeof v === 'string' ? new Date(v) : v;
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [[60_000, 'second'], [3_600_000, 'minute'], [86_400_000, 'hour'], [604_800_000, 'day'], [2_592_000_000, 'week'], [31_536_000_000, 'month']];
  const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
  for (let i = 0; i < units.length; i++) {
    if (abs < units[i][0]) {
      const base = i === 0 ? 1000 : units[i - 1][0];
      return rtf.format(Math.round(diff / base), units[i][1]);
    }
  }
  return rtf.format(Math.round(diff / 31_536_000_000), 'year');
}
export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function fmtNumber(n: number): string { return new Intl.NumberFormat().format(n); }
export function plural(n: number, s: string, p = s + 's'): string { return `${fmtNumber(n)} ${n === 1 ? s : p}`; }

// A due date said the way somebody would say it. "By Sep 4" needs the reader
// to work out whether that has been and gone; "4 days late" does not, which
// matters on a list where being late is the only thing worth spotting.
// Days are counted between calendar days rather than in 24-hour steps, so
// something due this evening is "today" and not "in 0 days".
export function dueIn(v: string | Date | null | undefined): { label: string; late: boolean; today: boolean } | null {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(new Date())) / 86_400_000);
  if (days < 0) return { label: days === -1 ? 'A day late' : `${-days} days late`, late: true, today: false };
  // Only today gets the flag the callers colour on. "Due tomorrow" in amber
  // down a whole column makes amber mean nothing by the second screen.
  if (days === 0) return { label: 'Due today', late: false, today: true };
  if (days === 1) return { label: 'Due tomorrow', late: false, today: false };
  if (days <= 7) return { label: `Due ${d.toLocaleDateString([], { weekday: 'long' })}`, late: false, today: false };
  return { label: `Due ${fmtDate(d, { always: true })}`, late: false, today: false };
}

export function stripHtml(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body?.textContent ?? '';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function fmtDuration(days: number, hours: number): string {
  const p: string[] = [];
  if (days) p.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) p.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  return p.join(' ') || 'no wait';
}

export function localDateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "Chrome on Linux" from a user-agent string; good enough for a session list.
export function describeUa(ua: string | null | undefined): string {
  if (!ua) return 'unknown client';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
