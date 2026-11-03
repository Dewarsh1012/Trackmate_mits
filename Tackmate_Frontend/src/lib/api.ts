import axios from 'axios';

const rawApiUrl = import.meta.env.VITE_API_URL || '';
const API_URL = rawApiUrl.includes(':5001')
    ? rawApiUrl.replace(':5001', ':5010')
    : (rawApiUrl || 'http://localhost:5010');

const api = axios.create({
    baseURL: `${API_URL}/api/v1`,
    headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (res) => res,
    (err) => {
        if (err.response?.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (window.location.pathname !== '/auth') {
                window.location.href = '/auth';
            }
        }
        return Promise.reject(err);
    }
);

export default api;
