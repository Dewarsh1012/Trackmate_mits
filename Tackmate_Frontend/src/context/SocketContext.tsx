import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { PollingSocket } from '../lib/pollingSocket';
import { invalidateApiCache } from '../lib/api';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { token, user, updateUser } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (token && user) {
      // Serverless hosts (Vercel) can't hold WebSockets: default to the polling transport.
      // Set VITE_REALTIME_MODE=socket to use Socket.IO against a long-running backend.
      if (import.meta.env.VITE_REALTIME_MODE !== 'socket') {
        const polling = new PollingSocket();
        polling.on('zones:changed', invalidateApiCache);
        polling.on('profile:verified', () => updateUser({ is_verified: true }));
        polling.on('safety_score', (d: { score?: number }) => { if (typeof d?.score === 'number') updateUser({ safety_score: d.score }); });
        polling.on('connect', () => setIsConnected(true));
        polling.on('disconnect', () => setIsConnected(false));
        setSocket(polling.asSocket());
        return () => { polling.close(); setSocket(null); setIsConnected(false); };
      }

      const rawSocketUrl = import.meta.env.VITE_API_URL || '';
      const socketUrl = rawSocketUrl.includes(':5001')
        ? rawSocketUrl.replace(':5001', ':5010')
        : (rawSocketUrl || 'http://localhost:5010');
      const newSocket = io(socketUrl, {
        auth: { token },
        transports: ['websocket']
      });

      newSocket.on('connect', () => {
        setIsConnected(true);
        console.log('Connected to Trackmate Real-time Engine');
        
        // Join role-specific rooms using the backend's socket events
        if (user.role === 'authority' || user.role === 'admin') {
            newSocket.emit('join:authority');
        } else if (user.role === 'tourist') {
            newSocket.emit('join:tourist', user.id);
        } else if (user.role === 'resident') {
            newSocket.emit('join:resident', user.id);
        } else if (user.role === 'business') {
            newSocket.emit('join:business', user.id);
        }
        // Also join generic user room for personal alerts
        newSocket.emit('join:user', user.id);

        if (user.ward) {
            const wardId = typeof user.ward === 'object' ? user.ward._id : user.ward;
            newSocket.emit('join:ward', wardId);
        }
      });

      newSocket.on('zones:changed', invalidateApiCache);
      newSocket.on('profile:verified', () => updateUser({ is_verified: true }));
      newSocket.on('safety_score', (d: { score?: number }) => { if (typeof d?.score === 'number') updateUser({ safety_score: d.score }); });

      newSocket.on('disconnect', () => {
        setIsConnected(false);
      });

      setSocket(newSocket);

      return () => {
        newSocket.close();
      };
    } else {
      setSocket(null);
      setIsConnected(false);
    }
  // Keyed on identity only: live profile updates (e.g. safety score) must not tear down the connection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id, user?.role]);

  return (
    <SocketContext.Provider value={{ socket, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (context === undefined) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
