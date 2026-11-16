import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import api from '../lib/api';
import type { User, UserRole } from '../types';

export type { User, UserRole };

interface AuthContextType {
    user: User | null;
    token: string | null;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<User>;
    register: (data: Record<string, unknown>) => Promise<{ user: User; blockchainId: string }>;
    logout: () => void;
    updateUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (token) {
            api.get('/auth/me')
                .then((res) => {
                    // /auth/me returns the raw profile (`_id`); the login response uses `id`. Keep one shape,
                    // otherwise anything keyed on user.id (realtime rooms, location updates) breaks after a reload.
                    const data = res.data.data;
                    setUser({ ...data, id: data.id ?? data._id });
                })
                .catch((err) => {
                    // Only an explicit rejection of the token ends the session. A dropped connection or a
                    // server restart must not sign someone out (they may be in a no-signal area mid-trip).
                    if (err?.response?.status === 401 || err?.response?.status === 403) {
                        localStorage.removeItem('token');
                        localStorage.removeItem('user');
                        setToken(null);
                        setUser(null);
                        return;
                    }
                    try {
                        const cached = localStorage.getItem('user');
                        if (cached) setUser(JSON.parse(cached));
                    } catch { /* unreadable cache: fall through to the login screen */ }
                })
                .finally(() => setIsLoading(false));
        } else {
            setIsLoading(false);
        }
    }, [token]);

    const login = async (email: string, password: string): Promise<User> => {
        const res = await api.post('/auth/login', { email, password });
        const { accessToken, user: u } = res.data.data;
        localStorage.setItem('token', accessToken);
        localStorage.setItem('user', JSON.stringify(u));
        setToken(accessToken);
        setUser(u);
        return u;
    };

    const register = async (data: Record<string, unknown>) => {
        const res = await api.post('/auth/register', data);
        const { accessToken, blockchainId, user: u } = res.data.data;
        localStorage.setItem('token', accessToken);
        localStorage.setItem('user', JSON.stringify(u));
        setToken(accessToken);
        setUser(u);
        return { user: u, blockchainId };
    };

    const logout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
    };

    const updateUser = (patch: Partial<User>) => setUser((prev) => (prev ? { ...prev, ...patch } : prev));

    return (
        <AuthContext.Provider value={{ user, token, isLoading, login, register, logout, updateUser }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
