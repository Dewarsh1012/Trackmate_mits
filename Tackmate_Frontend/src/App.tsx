import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { LanguageProvider } from './i18n';
import AuthGuard from './components/AuthGuard';
import MobileNav from './components/layout/MobileNav';
import { useAuth } from './context/AuthContext';

/** Once an authority user is signed in and idle, fetch the other sections so tab switches are instant. */
function PrefetchAuthorityPages() {
    const { user } = useAuth();
    useEffect(() => {
        if (user?.role !== 'authority' && user?.role !== 'admin') return;
        const loaders = [
            () => import('./pages/authority/Dashboard'), () => import('./pages/authority/Incidents'),
            () => import('./pages/authority/AuthorityRosters'), () => import('./pages/authority/ZoneManagement'),
            () => import('./pages/authority/DailyCheckins'), () => import('./pages/authority/Efir'),
            () => import('./pages/authority/Analytics'), () => import('./pages/authority/AlertComposer'),
            () => import('./pages/authority/WalletVerify'),
        ];
        const idle = (window as any).requestIdleCallback || ((fn: () => void) => setTimeout(fn, 1500));
        const handle = idle(() => loaders.forEach((load) => { void load(); }));
        return () => { (window as any).cancelIdleCallback?.(handle); };
    }, [user?.role]);
    return null;
}
import SosAlarm from './components/alerts/SosAlarm';
import OfflineSosBanner from './components/alerts/OfflineSosBanner';
import HooterOverlay from './components/alerts/HooterOverlay';

// Public Pages
const LandingPage = lazy(() => import('./pages/LandingPage'));
const AuthPage = lazy(() => import('./pages/auth/AuthPage'));
const VerifyPage = lazy(() => import('./pages/verify/VerifyPage'));
const AuthorityWallet = lazy(() => import('./pages/authority/WalletVerify'));
const HooterAlert = lazy(() => import('./pages/HooterAlert'));
const NotFound = lazy(() => import('./pages/NotFound'));

// Role Pages
const TouristDashboard = lazy(() => import('./pages/tourist/Dashboard'));
const TouristProfile = lazy(() => import('./pages/tourist/Profile'));
const TouristItinerary = lazy(() => import('./pages/tourist/Itinerary'));
const ResidentDashboard = lazy(() => import('./pages/resident/Dashboard'));
const ResidentReport = lazy(() => import('./pages/resident/Report'));
const ResidentFeed = lazy(() => import('./pages/resident/Feed'));
const BusinessDashboard = lazy(() => import('./pages/business/Dashboard'));
const BusinessProfile = lazy(() => import('./pages/business/Profile'));
const AuthorityDashboard = lazy(() => import('./pages/authority/Dashboard'));
const AuthorityEfir = lazy(() => import('./pages/authority/Efir'));
const AuthorityAnalytics = lazy(() => import('./pages/authority/Analytics'));
const AuthorityIncidents = lazy(() => import('./pages/authority/Incidents'));
const AuthorityRosters = lazy(() => import('./pages/authority/AuthorityRosters'));
const AuthorityZones = lazy(() => import('./pages/authority/ZoneManagement'));
const AlertComposer = lazy(() => import('./pages/authority/AlertComposer'));
const UserDetail = lazy(() => import('./pages/authority/UserDetail'));
const DailyCheckins = lazy(() => import('./pages/authority/DailyCheckins'));

export default function App() {
    return (
        <LanguageProvider>
            <BrowserRouter>
                <AuthProvider>
                    <SocketProvider>
                        <Suspense fallback={<div className="page-loading"><div className="spinner" /></div>}>
                        <Routes>
                            {/* Public Routes */}
                            <Route path="/" element={<LandingPage />} />
                            <Route path="/auth" element={<AuthPage />} />
                            <Route path="/verify/:blockchainId" element={<VerifyPage />} />
                            <Route path="/hooter" element={<HooterAlert />} />

                            {/* Tourist Routes */}
                            <Route path="/tourist/*" element={
                                <AuthGuard role="tourist">
                                    <div className="min-h-screen pb-[80px] md:pb-0" style={{ background: 'var(--clay-bg)' }}>
                                        <Routes>
                                            <Route path="dashboard" element={<TouristDashboard />} />
                                            <Route path="itinerary" element={<TouristItinerary />} />
                                            <Route path="plan" element={<TouristItinerary />} />
                                            <Route path="profile" element={<TouristProfile />} />
                                            <Route path="*" element={<Navigate to="dashboard" replace />} />
                                        </Routes>
                                    </div>
                                </AuthGuard>
                            } />

                            {/* Resident Routes */}
                            <Route path="/resident/*" element={
                                <AuthGuard role="resident">
                                    <div className="min-h-screen pb-[80px] md:pb-0" style={{ background: 'var(--clay-bg)' }}>
                                        <Routes>
                                            <Route path="dashboard" element={<ResidentDashboard />} />
                                            <Route path="feed" element={<ResidentFeed />} />
                                            <Route path="incidents" element={<ResidentFeed />} />
                                            <Route path="report" element={<ResidentReport />} />
                                            <Route path="*" element={<Navigate to="dashboard" replace />} />
                                        </Routes>
                                    </div>
                                </AuthGuard>
                            } />

                            {/* Business Routes */}
                            <Route path="/business/*" element={
                                <AuthGuard role="business">
                                    <div className="min-h-screen pb-[80px] md:pb-0" style={{ background: 'var(--clay-bg)' }}>
                                        <Routes>
                                            <Route path="dashboard" element={<BusinessDashboard />} />
                                            <Route path="profile" element={<BusinessProfile />} />
                                            <Route path="*" element={<Navigate to="dashboard" replace />} />
                                        </Routes>
                                    </div>
                                </AuthGuard>
                            } />

                            {/* Authority Routes */}
                            <Route path="/authority/*" element={
                                <AuthGuard role="authority">
                                    <div className="min-h-screen pb-[76px] md:pb-0" style={{ background: 'var(--clay-bg)' }}>
                                        <Routes>
                                            <Route path="dashboard" element={<AuthorityDashboard />} />
                                            <Route path="incidents" element={<AuthorityIncidents />} />
                                            <Route path="tourists" element={<AuthorityRosters />} />
                                            <Route path="residents" element={<AuthorityRosters />} />
                                            <Route path="businesses" element={<AuthorityRosters />} />
                                            <Route path="zones" element={<AuthorityZones />} />
                                            <Route path="checkins" element={<DailyCheckins />} />
                                            <Route path="efir" element={<AuthorityEfir />} />
                                            <Route path="analytics" element={<AuthorityAnalytics />} />
                                            <Route path="wallet" element={<AuthorityWallet />} />
                                            <Route path="alerts" element={<AlertComposer />} />
                                            <Route path="user/:userId" element={<UserDetail />} />
                                            <Route path="*" element={<Navigate to="dashboard" replace />} />
                                        </Routes>
                                    </div>
                                </AuthGuard>
                            } />

                            <Route path="*" element={<NotFound />} />
                        </Routes>
                        </Suspense>
                        <MobileNav />
                        <SosAlarm />
                        <PrefetchAuthorityPages />
                        <OfflineSosBanner />
                        <HooterOverlay />
                    </SocketProvider>
                </AuthProvider>
            </BrowserRouter>
        </LanguageProvider>
    );
}
