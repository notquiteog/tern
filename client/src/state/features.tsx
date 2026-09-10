// What this person has turned on, held once for the whole app.
//
// Every new feature asks this before it draws anything. That is not a
// nicety: a page that renders a "Summarise" button and then fails with 403
// when it is pressed has told the person the feature exists and then lied
// about it. So the rule throughout the client is that a capability which is
// not granted produces no control at all, and the place to turn it on is
// named once, in Settings → Features.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from './auth';

export type Capability =
  | 'ai.compose' | 'ai.summaries' | 'ai.responders' | 'ai.campaigns' | 'ai.playground' | 'ai.media' | 'ai.assistant'
  | 'semantic' | 'triage' | 'guard' | 'attachments' | 'commitments'
  | 'nlrules' | 'brief' | 'voice' | 'calendar' | 'links' | 'import' | 'enrich';

export interface CapabilityInfo {
  id: Capability;
  label: string;
  what: string;
  readsMail: boolean;
  usesAi: boolean;
  heavy: boolean;
  adminOnly?: boolean;
  erases?: string;
  /** The install allows it. */
  available: boolean;
  /** This person has turned it on. */
  granted: boolean;
  /** How many rows it is holding for them right now. */
  holds: number;
}

interface FeaturesValue {
  capabilities: CapabilityInfo[];
  loading: boolean;
  /** Both gates open. The only question any feature should ask. */
  can: (cap: Capability) => boolean;
  info: (cap: Capability) => CapabilityInfo | undefined;
  grant: (cap: Capability) => Promise<void>;
  revoke: (cap: Capability) => Promise<{ erased: number }>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FeaturesValue>({
  capabilities: [], loading: true,
  can: () => false, info: () => undefined,
  grant: async () => {}, revoke: async () => ({ erased: 0 }), refresh: async () => {},
});

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setCapabilities([]); setLoading(false); return; }
    try {
      const r = await api.get<{ capabilities: CapabilityInfo[] }>('/api/features');
      setCapabilities(r.capabilities);
    } catch {
      // A features call that fails leaves everything off, which is the safe
      // way to be wrong: no control appears, rather than one that will fail.
      setCapabilities([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<FeaturesValue>(() => {
    const byId = new Map(capabilities.map((c) => [c.id, c]));
    return {
      capabilities,
      loading,
      can: (cap) => { const c = byId.get(cap); return Boolean(c?.available && c?.granted); },
      info: (cap) => byId.get(cap),
      grant: async (cap) => { await api.post(`/api/features/${cap}/grant`); await refresh(); },
      revoke: async (cap) => {
        const r = await api.post<{ erased: number }>(`/api/features/${cap}/revoke`);
        await refresh();
        return r;
      },
      refresh,
    };
  }, [capabilities, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFeatures(): FeaturesValue { return useContext(Ctx); }

// The common case, as one line: `const canSearch = useCan('semantic')`.
export function useCan(cap: Capability): boolean { return useContext(Ctx).can(cap); }
