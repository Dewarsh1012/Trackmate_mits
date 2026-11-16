import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { processLocationUpdate, LocationUpdate } from '../lib/locationProcessor';

let io: SocketIOServer | null = null;

// Track last heartbeat per user for offline detection
const userLastSeen = new Map<string, number>();

export function initSocket(httpServer: HTTPServer): SocketIOServer {
    const corsOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map(s => s.trim());
    corsOrigins.push('http://localhost:3000');
    corsOrigins.push('http://localhost:4200');

    io = new SocketIOServer(httpServer, {
        cors: {
            origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
                if (!origin || origin.startsWith('http://localhost:') || corsOrigins.includes(origin)) {
                    callback(null, true);
                } else {
                    callback(new Error(`Socket CORS policy origin ${origin} is not allowed`));
                }
            },
            methods: ['GET', 'POST'],
            credentials: true,
        },
        transports: ['websocket', 'polling'],
    });

    io.on('connection', (socket: Socket) => {
        console.log(`🔌 Socket connected: ${socket.id}`);

        // Client announces its role to join relevant rooms
        socket.on('join:authority', () => {
            socket.join('authority_room');
            console.log(`👮 Authority joined: ${socket.id}`);
        });

        socket.on('join:ward', (wardId: string) => {
            socket.join(`ward_${wardId}`);
        });

        socket.on('join:tourist', (userId: string) => {
            socket.join(`tourist_${userId}`);
            socket.join(`user_${userId}`);
            socket.join('role_tourist');
            userLastSeen.set(userId, Date.now());
        });

        socket.on('join:resident', (userId: string) => {
            socket.join(`user_${userId}`);
            socket.join('role_resident');
            userLastSeen.set(userId, Date.now());
        });

        socket.on('join:business', (userId: string) => {
            socket.join(`user_${userId}`);
            socket.join('role_business');
            userLastSeen.set(userId, Date.now());
        });

        socket.on('join:user', (userId: string) => {
            socket.join(`user_${userId}`);
        });

        socket.on('join:zone', (zoneId: string) => {
            socket.join(`zone_${zoneId}`);
        });

        socket.on('join:incident', (incidentId: string) => {
            socket.join(`incident_${incidentId}`);
        });

        socket.on('leave:incident', (incidentId: string) => {
            socket.leave(`incident_${incidentId}`);
        });

        // ─── Location Update via Socket (5s interval from clients) ───
        socket.on('location_update', async (data: LocationUpdate) => {
            try {
                if (!data || !data.userId) return;
                userLastSeen.set(data.userId, Date.now());
                await processLocationUpdate(io!, data);
            } catch (err) {
                console.error('Socket location_update error:', err);
            }
        });

        // Ping/pong keep-alive
        socket.on('ping', () => socket.emit('pong'));

        socket.on('disconnect', () => {
            console.log(`🔴 Socket disconnected: ${socket.id}`);
        });
    });

    // Offline detection: check every 60s for users not seen in 2 min
    setInterval(() => {
        const cutoff = Date.now() - 2 * 60 * 1000;
        for (const [userId, lastSeen] of userLastSeen.entries()) {
            if (lastSeen < cutoff) {
                io!.to('authority_room').emit('user_offline', { userId, lastSeen: new Date(lastSeen).toISOString() });
                userLastSeen.delete(userId);
            }
        }
    }, 60 * 1000);

    return io;
}

export function getIO(): SocketIOServer {
    if (!io) throw new Error('Socket.IO not initialised. Call initSocket() first.');
    return io;
}
