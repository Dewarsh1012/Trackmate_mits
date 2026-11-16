import api from './api';

const OFFLINE_SOS_QUEUE_KEY = 'trackmate.offlineSosQueue.v1';
const MAX_QUEUE_ITEMS = 24;
const SEND_TIMEOUT_MS = 8000;
const RETRY_EVERY_MS = 4000;
export const SOS_QUEUE_EVENT = 'trackmate:sos-queue';

export interface OfflineSosQueueItem {
    id: string;
    payload: Record<string, any>;
    role: string;
    createdAt: string;
}

export function enqueueOfflineSos(payload: Record<string, any>, role: string): OfflineSosQueueItem {
    const queue = readQueue();
    const item: OfflineSosQueueItem = {
        id: `sos_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        payload,
        role,
        createdAt: new Date().toISOString(),
    };

    // Idempotency key + original trigger time, so a retry after a half-delivered attempt can't
    // create a duplicate, and authorities see when the person actually pressed the button.
    item.payload = {
        ...payload,
        metadata: {
            ...(payload.metadata || {}),
            client_request_id: item.id,
            triggered_at: item.createdAt,
            sent_from_offline_queue: true,
        },
    };

    const nextQueue = [item, ...queue].slice(0, MAX_QUEUE_ITEMS);
    writeQueue(nextQueue);
    notifyQueueChanged();
    void flushOfflineSosQueue();
    return item;
}

export function getOfflineSosQueueCount(): number {
    return readQueue().length;
}

let activeFlush: Promise<{ sent: number; failed: number; queued: number }> | null = null;

/** Sends queued SOS alerts. Calls made while a flush is running share its result. */
export function flushOfflineSosQueue(): Promise<{ sent: number; failed: number; queued: number }> {
    if (!activeFlush) {
        activeFlush = doFlush().finally(() => { activeFlush = null; });
    }
    return activeFlush;
}

async function doFlush(): Promise<{ sent: number; failed: number; queued: number }> {
    const queue = readQueue();
    if (queue.length === 0) return { sent: 0, failed: 0, queued: 0 };

    const remaining: OfflineSosQueueItem[] = [];
    let sent = 0;
    let failed = 0;

    for (const item of queue.reverse()) {
        try {
            await api.post('/incidents', item.payload, { timeout: SEND_TIMEOUT_MS });
            sent += 1;
        } catch {
            failed += 1;
            remaining.push(item);
        }
    }

    writeQueue(remaining.reverse());
    notifyQueueChanged();
    return {
        sent,
        failed,
        queued: remaining.length,
    };
}

function readQueue(): OfflineSosQueueItem[] {
    try {
        const raw = localStorage.getItem(OFFLINE_SOS_QUEUE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => item && typeof item === 'object' && item.payload);
    } catch {
        return [];
    }
}

function writeQueue(queue: OfflineSosQueueItem[]): void {
    localStorage.setItem(OFFLINE_SOS_QUEUE_KEY, JSON.stringify(queue));
}

export function getOfflineSosQueue(): OfflineSosQueueItem[] {
    return readQueue();
}

function notifyQueueChanged(): void {
    window.dispatchEvent(new CustomEvent(SOS_QUEUE_EVENT, { detail: { count: readQueue().length } }));
}

/**
 * Keeps trying to deliver queued SOS alerts: on reconnect, when the tab becomes visible again,
 * and every few seconds while anything is pending (a "connected" phone can still have no data).
 * Returns a stop function.
 */
export function startOfflineSosSync(): () => void {
    const attempt = () => { if (readQueue().length > 0) void flushOfflineSosQueue(); };
    const timer = window.setInterval(attempt, RETRY_EVERY_MS);
    window.addEventListener('online', attempt);
    document.addEventListener('visibilitychange', attempt);
    attempt();
    notifyQueueChanged();
    return () => {
        window.clearInterval(timer);
        window.removeEventListener('online', attempt);
        document.removeEventListener('visibilitychange', attempt);
    };
}
