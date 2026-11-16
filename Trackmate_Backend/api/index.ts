import '../src/config/serverless';
import type { IncomingMessage, ServerResponse } from 'http';
import mongoose from 'mongoose';
import app from '../src/app';
import { connectDatabase } from '../src/config/database';
import { pollingBus, flushRealtime } from '../src/lib/realtime';

// Serverless entry: no WebSocket server, so realtime events go through the
// Mongo-backed polling bus. The DB connection is reused across warm invocations.
app.set('io', pollingBus);

let ready: Promise<void> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
    if (mongoose.connection.readyState !== 1) {
        ready = ready || connectDatabase().catch((e) => { ready = null; throw e; });
        await ready;
    }

    const finished = new Promise<void>((resolve) => res.on('close', () => resolve()));
    (app as any)(req, res);
    await finished;
    await flushRealtime();
}
