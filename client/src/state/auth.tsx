import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from '../api';

export interface User { id: number; username: string; display_name: string; role: 'admin' | 'member'; totp_enabled: boolean; prefs: Record<string, any>; created_at: string; last_login_at: string | null; avatar_version: number | null }
interface AuthCtx { user: User | null; loading: boolean; needsSetup: boolean; registrationOpen: boolean; stalwartProvisioning: boolean; accountCount: number; version: string; refresh: () => Promise<void>; setUser: (u: User | null) => void; logout: () => Promise<void> }

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [stalwartProvisioning, setStalwartProvisioning] = useState(false);
  const [accountCount, setAccountCount] = useState(0);
  const [version, setVersion] = useState('');

  const refresh = useCallback(async () => {
    try {
      const status = await api.get<{ needsSetup: boolean; version: string; registrationOpen?: boolean }>('/api/setup/status');
      setNeedsSetup(status.needsSetup);
      setRegistrationOpen(Boolean(status.registrationOpen));
      setVersion(status.version);
      if (status.needsSetup) { setUser(null); return; }
      const me = await api.get<{ user: User; accountCount: number; stalwartProvisioning?: boolean }>('/api/auth/me');
      setUser(me.user);
      setAccountCount(me.accountCount);
      setStalwartProvisioning(Boolean(me.stalwartProvisioning));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(() => setUser(null)); }, []);

  const logout = useCallback(async () => { try { await api.post('/api/auth/logout'); } finally { setUser(null); } }, []);
  const value = useMemo(() => ({ user, loading, needsSetup, registrationOpen, stalwartProvisioning, accountCount, version, refresh, setUser, logout }), [user, loading, needsSetup, registrationOpen, stalwartProvisioning, accountCount, version, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
