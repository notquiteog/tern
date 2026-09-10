import { useEffect } from 'react';

type Resource = 'calendar' | 'commitments';

// Assistant cards can update a resource while its page is still on screen.
export function notifyWorkspaceChange(resource: Resource): void {
  window.dispatchEvent(new Event(`tern:${resource}-changed`));
}

export function useWorkspaceChange(resource: Resource, refresh: () => void): void {
  useEffect(() => {
    const event = `tern:${resource}-changed`;
    window.addEventListener(event, refresh);
    return () => window.removeEventListener(event, refresh);
  }, [resource, refresh]);
}
