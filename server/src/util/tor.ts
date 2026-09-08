// Reaching a model server through Tor.
//
// This is for one situation and it is worth naming, because the setting looks
// pointless otherwise: the model is somebody else's machine. A rented GPU host
// learns the address of every client that talks to it, and for an install that
// does not want its mail server's address in that log — or that is reaching an
// .onion address in the first place — the connection goes through a local Tor
// proxy instead.
//
// It is off by default and it is not a privacy feature for the *content*: what
// crosses is the same prompt either way, and Admin → AI model says plainly
// whether the model is local. What Tor changes is who learns where this
// install is. A model running on this box has nothing to gain from it.
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config.js';

// Arti's default SocksPort. The C tor daemon uses 9050, which is deliberately
// NOT a fallback: any unprivileged local process can bind 9050, and silently
// retrying there after a refusal would route this install's traffic to
// whichever process won that port — invisibly, which is the worst possible
// failure for a setting whose whole purpose is controlling where traffic goes.
// Tern dials the port it was told to dial and explains what it saw.
export const DEFAULT_TOR_PORT = 9150;
export const LEGACY_TOR_PORT = 9050;

// The shortest timeout anything over Tor may have. A floor rather than a
// default: a caller asking for less gets this, a caller asking for more keeps
// what it asked for.
//
// socks-proxy-agent applies its own 30-second ceiling when nobody passes a
// timeout, and 30 seconds is inside the normal range for building a circuit —
// let alone an onion rendezvous on a slow evening. Without the floor a working
// model server is reported unreachable on a slow circuit, which reads as "the
// setting is broken" rather than "the circuit was slow".
export const TOR_MIN_TIMEOUT_MS = 120_000;

export function torTimeoutMs(requested?: number): number {
  return Number.isFinite(requested) && (requested as number) > TOR_MIN_TIMEOUT_MS
    ? (requested as number)
    : TOR_MIN_TIMEOUT_MS;
}

/**
 * A SOCKS5 agent pointed at the local Tor proxy.
 *
 * `socks5h` rather than `socks5` so the *proxy* resolves the hostname. Two
 * reasons, and the second is the one that is easy to miss:
 *
 *  - an .onion name has no DNS at all, so a local lookup fails before the
 *    request is ever sent;
 *  - for an ordinary hostname a local lookup still tells this machine's
 *    resolver — and therefore its network — exactly which model host is about
 *    to be contacted. Routing the bytes over Tor while leaking the name to the
 *    ISP is most of the cost of the feature and none of the benefit.
 */
export function torAgent(timeoutMs?: number): SocksProxyAgent {
  return new SocksProxyAgent(`socks5h://${config.torSocksHost}:${config.torSocksPort}`, {
    timeout: torTimeoutMs(timeoutMs),
  });
}

/** Where this install thinks Tor is, for the admin page and for error text. */
export function torProxyAddress(): string {
  return `${config.torSocksHost}:${config.torSocksPort}`;
}

/**
 * What a refused connection to the proxy most likely means.
 *
 * The common case by a distance is an install running the C tor daemon on 9050
 * while this defaults to Arti's 9150, and "connection refused" alone sends
 * somebody to check whether Tor is running when it plainly is.
 */
export function explainTorError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|ECONNRESET|socks/i.test(msg)) {
    const hint = config.torSocksPort === DEFAULT_TOR_PORT
      ? ` If you run the C tor daemon rather than Arti, its SOCKS port is ${LEGACY_TOR_PORT} — set TOR_SOCKS_PORT.`
      : '';
    return `No Tor proxy answered at ${torProxyAddress()}.${hint}`;
  }
  if (/timeout|ETIMEDOUT/i.test(msg)) {
    return `The Tor proxy at ${torProxyAddress()} did not build a circuit in time. A slow circuit is normal; a repeated failure is not.`;
  }
  // Not a proxy failure. Null rather than the raw message, so the caller falls
  // back to explainOutboundError — which knows far more about what a model
  // server's refusal means than this file does.
  return null;
}
