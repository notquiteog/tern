// In-process event bus. Sync workers publish here; the /api/events SSE route
// fans out to browsers so the inbox updates without polling. Single process by
// design: the whole app fits one container on a 4 GB box.
import { EventEmitter } from 'node:events';

export type AppEvent =
  | { type: 'sync'; userId: number; accountId: number; created?: number }
  | { type: 'account'; userId: number; accountId: number; status: string; error?: string | null }
  | { type: 'send'; userId: number; accountId: number; contactId?: number | null; ok: boolean; subject?: string; error?: string }
  | { type: 'enrollment'; userId: number; sequenceId: number; enrollmentId: number; status: string }
  | { type: 'review'; userId: number; count: number }
  | { type: 'ai'; userId: number; status: string };

class Bus extends EventEmitter {}
export const bus = new Bus();
bus.setMaxListeners(500);

export function publish(ev: AppEvent) {
  bus.emit('event', ev);
}
