import { RealtimeEvent } from '../models';
import { waitUntil } from '@vercel/functions';

/**
 * Socket.IO-compatible emitter for serverless deployments, where long-lived
 * WebSocket connections are impossible. `io.to(a).to(b).emit(ev, data)` persists
 * the event; clients receive it via GET /api/v1/realtime/poll.
 */
export interface Emitter {
    to(room: string): Emitter;
    emit(event: string, payload?: unknown): boolean;
}

const pending = new Set<Promise<unknown>>();

class PollingEmitter implements Emitter {
    constructor(private rooms: string[] = []) {}

    to(room: string): Emitter {
        return new PollingEmitter([...this.rooms, room]);
    }

    emit(event: string, payload?: unknown): boolean {
        const rooms = [...new Set(this.rooms)];
        if (!rooms.length) return false;
        let data: unknown;
        try {
            data = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
        } catch {
            data = null;
        }
        const p = RealtimeEvent.create({ rooms, event, payload: data })
            .catch((err: unknown) => console.error('Realtime emit failed:', err))
            .finally(() => pending.delete(p));
        pending.add(p);
        if (process.env.VERCEL) {
            try { waitUntil(p); } catch { /* not inside a request context */ }
        }
        return true;
    }
}

export const pollingBus: Emitter = new PollingEmitter();

/** Keeps background work alive until the serverless function is flushed. */
export function runAfterResponse(task: Promise<unknown>): void {
    const p = task.catch((err) => console.error('Background task failed:', err)).finally(() => pending.delete(p));
    pending.add(p);
    // On Vercel, waitUntil keeps the invocation alive after the response has been sent.
    if (process.env.VERCEL) {
        try { waitUntil(p); } catch { /* not inside a request context */ }
    }
}

/** Resolves once every queued emit has been written (call before a function exits). */
export async function flushRealtime(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
}

export function roomsForUser(user: { userId: string; role: string }, extra: string[] = []): string[] {
    const rooms = [`user_${user.userId}`, `role_${user.role}`];
    if (user.role === 'tourist') rooms.push(`tourist_${user.userId}`);
    if (user.role === 'authority' || user.role === 'admin') rooms.push('authority_room');
    for (const r of extra) {
        if (/^(ward|incident|zone)_[a-f0-9]{24}$/i.test(r)) rooms.push(r);
    }
    return rooms;
}
