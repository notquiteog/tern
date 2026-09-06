// Browser side of Web Push: permission, subscription through the service
// worker, and the server calls that register or drop this device.
import { api } from '../api';

export type PushState = 'unsupported' | 'no-worker' | 'denied' | 'off' | 'on';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const reg = await registration();
  if (!reg) return 'no-worker';
  if (Notification.permission === 'denied') return 'denied';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

function toKey(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('Notifications need the installed app or a production build');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed in the browser');
  const { publicKey } = await api.get<{ publicKey: string }>('/api/push/vapid');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) as BufferSource }));
  await api.post('/api/push/subscribe', sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}
