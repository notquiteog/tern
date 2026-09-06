/// <reference types="vite/client" />
// Register the service worker in production builds. When a new build has
// been installed behind the running page, tell the app so it can offer a
// reload instead of reloading under someone mid-sentence.
export const SW_UPDATED_EVENT = 'tern:sw-updated';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const watch = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            w.postMessage('skipWaiting');
            window.dispatchEvent(new CustomEvent(SW_UPDATED_EVENT));
          }
        });
      };
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Look for a new build whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void reg.update(); });
    }).catch(() => { /* offline use is a nicety, never an error */ });
  });
}
