import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler } from '../api';

export interface User { id: number; username: string; display_name: string; role: 'admin' | 'member'; totp_enabled: boolean; prefs: Record<string, any>; created_at: string; last_login_at: string | null; avatar_version: number | null; pgp_fingerprint?: string | null; pgp_auth?: 'off' | 'second_factor' | 'passwordless' }
export interface Branding { name: string; logo: string | null; version: number }
const DEFAULT_BRANDING: Branding = { name: 'Tern', logo: null, version: 0 };
interface AuthCtx { user: User | null; loading: boolean; needsSetup: boolean; registrationOpen: boolean; stalwartProvisioning: boolean; accountCount: number; version: string; branding: Branding; refresh: () => Promise<void>; setUser: (u: User | null) => void; logout: () => Promise<void> }

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [stalwartProvisioning, setStalwartProvisioning] = useState(false);
  const [accountCount, setAccountCount] = useState(0);
  const [version, setVersion] = useState('');
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);

  const refresh = useCallback(async () => {
    try {
      const status = await api.get<{ needsSetup: boolean; version: string; registrationOpen?: boolean; branding?: Branding }>('/api/setup/status');
      setBranding(status.branding?.name ? status.branding : DEFAULT_BRANDING);
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
  // Tab title and favicon follow the branding; the default icon is a static file.
  useEffect(() => {
    document.title = branding.name;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = branding.logo ?? '/favicon.svg';
    if (branding.logo) link.removeAttribute('type'); else link.type = 'image/svg+xml';
    document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', branding.name);
    document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.setAttribute('href', `/icons/apple-touch-icon.png?v=${branding.version}`);
    document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute('href', `/manifest.webmanifest?v=${branding.version}`);
  }, [branding]);
  useEffect(() => { setUnauthorizedHandler(() => { setUser(null); qc.clear(); }); }, [qc]);

  // Signing out also empties the in-memory query cache so mail, contacts and
  // drafts are not one Back button away on a shared machine.
  const logout = useCallback(async () => { try { await api.post('/api/auth/logout'); } finally { setUser(null); qc.clear(); } }, [qc]);
  const value = useMemo(() => ({ user, loading, needsSetup, registrationOpen, stalwartProvisioning, accountCount, version, branding, refresh, setUser, logout }), [user, loading, needsSetup, registrationOpen, stalwartProvisioning, accountCount, version, branding, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
