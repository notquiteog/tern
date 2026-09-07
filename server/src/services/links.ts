// F11: link hygiene, in both directions.
//
// Remote images are already blocked, which stops the pixel that says a
// message was opened. It does not stop the other half: a link whose query
// string carries a campaign identifier, or a link that goes to a redirector
// so the sender learns you clicked before you arrive anywhere. This handles
// both, on mail you are shown and on mail you send.
//
// Everything here is a pure function over a URL string. Nothing is fetched:
// resolving a redirect by following it would be a request from this server
// to a stranger's, on behalf of somebody who has not clicked anything yet,
// which is precisely the surveillance being removed. Wrapped links are
// unwrapped by reading the destination the wrapper itself put in the query
// string, which covers the common ones and honestly fails on the rest.
export const TRACKING_PARAMS = [
  // Campaign tagging, in the four flavours everyone uses.
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'mc_cid', 'mc_eid', 'mkt_tok', 'ml_subscriber', 'ml_subscriber_hash',
  'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium', 'piwik_campaign',
  'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt', 'hsa_net', 'hsa_ver',
  '_hsenc', '_hsmi', 'hsCtaTracking',
  // Per-click identifiers set by ad networks.
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid', 'ttclid',
  'igshid', 'li_fat_id', 'epik', 'rdt_cid', 'yclid', 's_kwcid', 'ef_id',
  // Per-recipient identifiers, which are the ones that actually identify you.
  'vero_conv', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'wickedid', 'sc_customer',
  'ck_subscriber_id', 'trk_contact', 'trk_msg', 'trk_module', 'trk_sid',
  'cmpid', 'ncid', 'sr_share', 'recipientid', 'contactid', 'customerid',
  '__s', '_openstat', 'spm', 'scm',
] as const;

const TRACKING_SET = new Set<string>(TRACKING_PARAMS);

// Prefix families rather than exact names: Adobe's `icid`, Salesforce's
// `sfmc_`, and anything a sender chose to call `utm_something_else`.
const TRACKING_PREFIXES = ['utm_', 'sfmc_', 'sfns_', 'icid_', 'at_custom', 'at_medium', 'ss_', 'mtm_'];

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  if (TRACKING_SET.has(n)) return true;
  return TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

// Redirectors that put their destination in the query string. The value is
// which parameter holds it. Anything not on this list is left alone rather
// than guessed at: unwrapping the wrong parameter would send somebody
// somewhere they did not ask to go, which is worse than the tracking.
const WRAPPERS: Record<string, string[]> = {
  'www.google.com': ['url', 'q'],
  'google.com': ['url', 'q'],
  'www.youtube.com': ['q'],
  'l.facebook.com': ['u'],
  'lm.facebook.com': ['u'],
  'l.instagram.com': ['u'],
  'away.vk.com': ['to'],
  'out.reddit.com': ['url'],
  't.umblr.com': ['z'],
  'href.li': ['?'],
  'www.bing.com': ['url'],
  'r.duckduckgo.com': ['uddg'],
  'steamcommunity.com': ['url'],
  'slack-redir.net': ['url'],
  'protect-us.mimecast.com': ['u'],
  'protect-eu.mimecast.com': ['u'],
  'urldefense.com': ['u'],
  'urldefense.proofpoint.com': ['u'],
  'safelinks.protection.outlook.com': ['url'],
  'eur01.safelinks.protection.outlook.com': ['url'],
  'eur02.safelinks.protection.outlook.com': ['url'],
  'eur03.safelinks.protection.outlook.com': ['url'],
  'nam01.safelinks.protection.outlook.com': ['url'],
  'nam02.safelinks.protection.outlook.com': ['url'],
  'nam03.safelinks.protection.outlook.com': ['url'],
  'nam04.safelinks.protection.outlook.com': ['url'],
  'nam10.safelinks.protection.outlook.com': ['url'],
  'nam11.safelinks.protection.outlook.com': ['url'],
  'nam12.safelinks.protection.outlook.com': ['url'],
};

export interface CleanedLink {
  /** Where the link actually goes, once unwrapped and stripped. */
  url: string;
  /** Whether anything was taken off. */
  changed: boolean;
  /** Which parameters were removed, for the "what did you do to my link" panel. */
  removed: string[];
  /** The redirector it was wrapped in, if it was. */
  unwrapped: string | null;
}

const UNCHANGED = (url: string): CleanedLink => ({ url, changed: false, removed: [], unwrapped: null });

// One pass: unwrap, then strip. Repeated because wrappers nest — a Mimecast
// link around a Safelinks link around a Mailchimp link is not unusual.
const MAX_UNWRAPS = 4;

export function cleanLink(input: string): CleanedLink {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 4000) return UNCHANGED(raw);
  // Anything that is not http(s) is left exactly as it is: mailto:, tel: and
  // cid: are not trackers and rewriting them would break them.
  if (!/^https?:\/\//i.test(raw)) return UNCHANGED(raw);

  let url: URL;
  try { url = new URL(raw); } catch { return UNCHANGED(raw); }

  const removed: string[] = [];
  let unwrapped: string | null = null;

  for (let i = 0; i < MAX_UNWRAPS; i++) {
    const host = url.hostname.toLowerCase();
    const params = WRAPPERS[host] ?? WRAPPERS[host.replace(/^www\./, '')];
    if (!params) break;
    let next: URL | null = null;
    for (const p of params) {
      // href.li puts the destination straight after the ?, with no name.
      const value = p === '?' ? url.search.slice(1) : url.searchParams.get(p);
      if (!value) continue;
      let candidate: string = value;
      // Proofpoint's v2 encoding swaps a handful of characters about.
      if (host.includes('urldefense')) candidate = candidate.replace(/-/g, '%').replace(/_/g, '/');
      try {
        const u = new URL(decodeURIComponent(candidate));
        if (u.protocol === 'http:' || u.protocol === 'https:') { next = u; break; }
      } catch { /* not a URL after all; leave the wrapper alone */ }
    }
    if (!next) break;
    unwrapped = host;
    url = next;
  }

  for (const name of [...url.searchParams.keys()]) {
    if (!isTracking(name)) continue;
    url.searchParams.delete(name);
    removed.push(name);
  }

  // A fragment that is only a tracking blob (#utm_source=…) goes too; a real
  // anchor stays.
  if (/^#?(utm_|mc_eid|mkt_tok)/i.test(url.hash.slice(1))) url.hash = '';

  const out = url.toString().replace(/\?$/, '');
  return { url: out, changed: out !== raw, removed, unwrapped };
}

// Rewrites every href in a fragment of HTML. Used on mail being displayed
// and on mail about to be sent, so a message forwarded through Tern does not
// carry somebody else's tracking to the next person.
export function cleanHtmlLinks(html: string): { html: string; removed: number; unwrapped: number } {
  let removed = 0, unwrapped = 0;
  const out = String(html ?? '').replace(/(<a\b[^>]*?\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi, (whole, prefix: string, _quoted: string, dq?: string, sq?: string) => {
    const href = dq ?? sq ?? '';
    const cleaned = cleanLink(decodeEntities(href));
    if (!cleaned.changed) return whole;
    removed += cleaned.removed.length;
    if (cleaned.unwrapped) unwrapped++;
    const q = dq !== undefined ? '"' : "'";
    return `${prefix}${q}${escapeAttr(cleaned.url)}${q}`;
  });
  return { html: out, removed, unwrapped };
}

export function cleanTextLinks(text: string): string {
  return String(text ?? '').replace(/https?:\/\/[^\s<>()[\]"']+/gi, (m) => cleanLink(m).url);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
