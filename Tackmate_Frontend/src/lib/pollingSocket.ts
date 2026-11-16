import type { Socket } from 'socket.io-client';
import api from './api';

type Handler = (payload: any) => void;

const LONG_POLL_SECONDS = 20;
const RETRY_INTERVAL_MS = 1500;
const MAX_BACKOFF_MS = 20000;

/**
 * Socket.IO-shaped client for serverless backends (no WebSocket support).
 * Events are pulled from GET /realtime/poll; room membership is derived from the
 * JWT server-side, and `location_update` is sent over HTTP.
 */
export class PollingSocket {
  connected = false;
  id = 'polling';
  private handlers = new Map<string, Set<Handler>>();
  private lifecycle = new Map<string, Set<() => void>>();
  private rooms = new Set<string>();
  private cursor = '';
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor() {
    queueMicrotask(() => void this.tick());
  }

  on(event: string, handler: Handler) {
    const map = event === 'connect' || event === 'disconnect' ? this.lifecycle : this.handlers;
    if (!map.has(event)) map.set(event, new Set());
    map.get(event)!.add(handler as () => void);
    if (event === 'connect' && this.connected) handler(undefined);
    return this;
  }

  off(event: string, handler?: Handler) {
    const map = event === 'connect' || event === 'disconnect' ? this.lifecycle : this.handlers;
    if (!handler) map.delete(event);
    else map.get(event)?.delete(handler as () => void);
    return this;
  }

  emit(event: string, data?: any) {
    if (event === 'location_update') {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      void api
        .post('/realtime/location', {
          latitude: num(data?.latitude),
          longitude: num(data?.longitude),
          accuracy: num(data?.accuracy),
          speed: num(data?.speed),
          battery: num(data?.battery),
          name: typeof data?.name === 'string' ? data.name : undefined,
        })
        .catch(() => undefined);
    } else if (event === 'join:incident' || event === 'join:ward' || event === 'join:zone') {
      this.rooms.add(`${event.split(':')[1]}_${data}`);
    } else if (event === 'leave:incident') {
      this.rooms.delete(`incident_${data}`);
    }
    return this;
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.setConnected(false);
    return this;
  }

  disconnect() {
    return this.close();
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.lifecycle.get(value ? 'connect' : 'disconnect')?.forEach((h) => h());
  }

  private async tick() {
    if (this.stopped) return;
    try {
      const res = await api.get('/realtime/poll', {
        // The first request (no cursor yet) returns immediately; after that the server holds the
        // request open until an event arrives, so delivery latency is a few hundred ms.
        params: { cursor: this.cursor || undefined, rooms: [...this.rooms].join(',') || undefined, wait: this.cursor ? LONG_POLL_SECONDS : undefined },
        timeout: (LONG_POLL_SECONDS + 10) * 1000,
      });
      this.failures = 0;
      this.cursor = res.data.cursor || this.cursor;
      this.setConnected(true);
      for (const { event, payload } of res.data.events ?? []) {
        this.handlers.get(event)?.forEach((h) => {
          try { h(payload); } catch (err) { console.error(`Realtime handler for ${event} failed`, err); }
        });
      }
    } catch {
      this.failures += 1;
      this.setConnected(false);
    }
    if (this.stopped) return;
    // Successful long polls re-arm immediately; failures back off.
    const delay = this.failures === 0 ? 0 : Math.min(MAX_BACKOFF_MS, RETRY_INTERVAL_MS * 2 ** Math.min(this.failures - 1, 3));
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  asSocket(): Socket {
    return this as unknown as Socket;
  }
}
