import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../config/database';
import { trainAll } from '../ml/training';

/** Retrain every ML model from the application database. Models that fail their quality gate are not replaced. */
async function run() {
    try {
        await connectDatabase();
        const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
        const reports = await trainAll(only.length ? only : undefined);
        for (const r of reports) {
            console.log(`\n${r.status === 'trained' ? '✅' : r.status === 'rejected' ? '⚠️ ' : '⏭️ '} ${r.name}: ${r.status}${r.version ? ` (${r.version})` : ''}`);
            if (r.reason) console.log(`   ${r.reason}`);
            if (r.samples != null) console.log(`   samples: ${r.samples}`);
            if (r.metrics) console.log(`   metrics: ${JSON.stringify(r.metrics)}`);
        }
    } catch (err) {
        console.error('❌ ML training failed:', err);
        process.exitCode = 1;
    } finally {
        await disconnectDatabase();
    }
}

void run();
