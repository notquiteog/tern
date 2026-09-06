// The app's own mark: the admin-set logo, or the default feather.
import { Feather } from 'lucide-react';
import { useAuth } from '../state/auth';

export function BrandLogo({ size = 16 }: { size?: number }) {
  const { branding } = useAuth();
  return <span className={branding.logo ? 'brand-logo custom' : 'brand-logo'}>{branding.logo ? <img src={branding.logo} alt="" /> : <Feather size={size} />}</span>;
}

export function useAppName(): string {
  return useAuth().branding.name;
}
