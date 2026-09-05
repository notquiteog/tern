// One runner per account: a push connection when the server offers one, a
// polling timer either way, and a debounced sync trigger that both feed.
// Re-syncing after a local action is also routed here so every path that
// changes the mailbox ends in the same place.
import { listAccounts } from '../services/accounts.js';
import { clientFor, getAccount } from '../services/accounts.js';
import { syncAccount } from '../jmap/sync.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { JmapError } from '../jmap/client.js';

const log = logger('syncmgr');

class AccountRunner {
  accountId: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private pushAbort: AbortController | null = null;
  private stopped = false;
  private pushBackoffMs = 5000;
  private again = false;
  lastPushAt: Date | null = null;
  pushState: 'off' | 'connecting' | 'connected' | 'error' = 'off';

  constructor(accountId: number) { this.accountId = accountId; }

  start(): void {
    this.stopped = false;
    this.requestSync(0);
    this.pollTimer = setInterval(() => this.requestSync(0), config.syncPollSeconds * 1000);
    void this.pushLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.pushAbort?.abort();
    this.pollTimer = null; this.debounce = null; this.pushAbort = null;
    this.pushState = 'off';
  }

  requestSync(delayMs: number): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    try {
      await syncAccount(this.accountId);
    } catch (e) {
      // Already logged by sync; credentials errors stop the push loop below.
    }
    if (this.again) { this.again = false; this.requestSync(300); }
  }

  // Called when a sync is already in flight and another is wanted after it.
  syncAfterCurrent(): void { this.again = true; }

  private async pushLoop(): Promise<void> {
    while (!this.stopped) {
      const acc = await getAccount(this.accountId);
      if (!acc || !acc.enabled) return;
      if (!acc.event_source_url) { this.pushState = 'off'; return; }
      if (acc.sync_status === 'auth_error') { this.pushState = 'error'; return; }
      const client = clientFor(acc);
      this.pushAbort = new AbortController();
      this.pushState = 'connecting';
      try {
        await client.eventSource((ev) => {
          if (ev.type === 'state' || (ev.type === 'message' && ev.data?.changed)) {
            this.pushState = 'connected';
            this.lastPushAt = new Date();
            const changed = ev.data?.changed ?? {};
            const mine = changed[client.session!.accountId] ?? Object.values(changed)[0] ?? {};
            if ('Email' in mine || 'Mailbox' in mine || 'Thread' in mine || !Object.keys(mine).length) this.requestSync(400);
          } else if (ev.type === 'ping') {
            this.pushState = 'connected';
            this.pushBackoffMs = 5000;
          }
        }, this.pushAbort.signal);
        this.pushState = 'off';
      } catch (e) {
        if (this.stopped) return;
        this.pushState = 'error';
        if (e instanceof JmapError && e.type === 'unauthorized') { log.warn(`push stopped for account ${this.accountId}: unauthorized`); return; }
        log.debug(`push connection ended for account ${this.accountId}`, { err: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, this.pushBackoffMs));
      this.pushBackoffMs = Math.min(this.pushBackoffMs * 2, 120_000);
    }
  }
}

const runners = new Map<number, AccountRunner>();

export const syncManager = {
  async start(): Promise<void> {
    const accounts = await listAccounts();
    for (const a of accounts) if (a.enabled) this.add(a.id);
    log.info(`sync manager started for ${runners.size} account(s)`);
  },
  add(accountId: number): void {
    if (runners.has(accountId)) return;
    const r = new AccountRunner(accountId);
    runners.set(accountId, r);
    r.start();
  },
  remove(accountId: number): void {
    runners.get(accountId)?.stop();
    runners.delete(accountId);
  },
  async refresh(accountId: number): Promise<void> {
    this.remove(accountId);
    const acc = await getAccount(accountId);
    if (acc?.enabled) this.add(accountId);
  },
  requestSync(accountId: number, delayMs = 800): void {
    const r = runners.get(accountId);
    if (!r) return;
    r.requestSync(delayMs);
    r.syncAfterCurrent();
  },
  status(accountId: number): { push: string; lastPushAt: Date | null } {
    const r = runners.get(accountId);
    return { push: r?.pushState ?? 'off', lastPushAt: r?.lastPushAt ?? null };
  },
  stop(): void {
    for (const r of runners.values()) r.stop();
    runners.clear();
  },
};
