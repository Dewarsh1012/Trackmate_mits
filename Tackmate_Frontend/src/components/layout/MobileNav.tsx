import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage, LANGUAGES } from '../../i18n';
import {
    Map,
    AlertTriangle,
    User,
    Navigation,
    Bell,
    BarChart3,
    LayoutDashboard,
    Fingerprint,
    Menu,
    X,
    Users,
    Home,
    Building2,
    CheckCircle2,
    LogOut,
    Globe,
    ChevronRight,
} from 'lucide-react';
import { CLAY_COLORS as C } from '../../theme/clayTheme';

export default function MobileNav() {
    const { user, logout } = useAuth();
    const { t, language, setLanguage, currentLang } = useLanguage();
    const navigate = useNavigate();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [langOpen, setLangOpen] = useState(false);

    if (!user) return null;

    const handleLogout = () => {
        setDrawerOpen(false);
        logout();
        navigate('/auth');
    };

    const touristLinks = [
        { to: '/tourist/dashboard', icon: <Map size={20} />, label: t('map') || 'Map' },
        { to: '/tourist/itinerary', icon: <Navigation size={20} />, label: t('trip') || 'Trip' },
        { to: '/tourist/profile', icon: <User size={20} />, label: t('profile') || 'Profile' },
    ];

    const residentLinks = [
        { to: '/resident/dashboard', icon: <Map size={20} />, label: t('local') || 'Ward' },
        { to: '/resident/feed', icon: <Bell size={20} />, label: t('feed') || 'Feed' },
        { to: '/resident/report', icon: <AlertTriangle size={20} />, label: t('report') || 'Report' },
    ];

    const businessLinks = [
        { to: '/business/dashboard', icon: <BarChart3 size={20} />, label: t('intel') || 'Ops' },
        { to: '/business/profile', icon: <User size={20} />, label: t('business') || 'Profile' },
    ];

    const authorityPrimaryLinks = [
        { to: '/authority/dashboard', icon: <LayoutDashboard size={20} />, label: t('dashboard') || 'Command' },
        { to: '/authority/incidents', icon: <AlertTriangle size={20} />, label: t('incidents') || 'Incidents' },
        { to: '/authority/zones', icon: <Map size={20} />, label: t('zoneManagement') || 'Zones' },
        { to: '/authority/efir', icon: <Fingerprint size={20} />, label: t('efirSystem') || 'E-FIR' },
    ];

    const authorityDrawerLinks = [
        { to: '/authority/tourists', icon: <Users size={18} color={C.primary} />, label: t('tourists') || 'Tourists' },
        { to: '/authority/residents', icon: <Home size={18} color={C.safe} />, label: t('residents') || 'Residents' },
        { to: '/authority/businesses', icon: <Building2 size={18} color={C.moderate} />, label: t('businesses') || 'Businesses' },
        { to: '/authority/checkins', icon: <CheckCircle2 size={18} color={C.primaryLight} />, label: t('dailyCheckins') || 'Check-ins' },
        { to: '/authority/analytics', icon: <BarChart3 size={18} color={C.accent} />, label: t('safetyAnalytics') || 'Analytics' },
        { to: '/authority/alerts', icon: <Bell size={18} color={C.critical} />, label: t('sendAlert') || 'Send Alert' },
    ];

    const isAuthority = user.role === 'authority' || user.role === 'admin';

    const links = isAuthority
        ? authorityPrimaryLinks
        : user.role === 'resident'
            ? residentLinks
            : user.role === 'business'
                ? businessLinks
                : touristLinks;

    return (
        <>
            {/* Mobile Bottom Navigation Bar */}
            <nav
                className="mobile-nav-bar"
                style={{
                    position: 'fixed',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    background: 'rgba(255, 255, 255, 0.94)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    borderTop: `1px solid ${C.border}`,
                    boxShadow: '0 -8px 24px rgba(27, 29, 42, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-around',
                    padding: '8px 4px calc(8px + env(safe-area-inset-bottom))',
                    zIndex: 999,
                }}
            >
                {links.map((link) => (
                    <NavLink
                        key={link.to}
                        to={link.to}
                        style={({ isActive }) => ({
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 3,
                            textDecoration: 'none',
                            color: isActive ? C.primary : C.textMuted,
                            fontFamily: "'Plus Jakarta Sans', sans-serif",
                            fontSize: '0.66rem',
                            fontWeight: isActive ? 800 : 600,
                            letterSpacing: '0.02em',
                            padding: '6px 4px',
                            borderRadius: 12,
                            background: isActive ? 'rgba(108, 99, 255, 0.08)' : 'transparent',
                            flex: 1,
                            minWidth: 0,
                            textAlign: 'center',
                            transition: 'all 0.15s ease',
                        })}
                    >
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {link.icon}
                        </span>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                            {link.label}
                        </span>
                    </NavLink>
                ))}

                {/* Authority "More" menu button */}
                {isAuthority && (
                    <button
                        onClick={() => setDrawerOpen(true)}
                        type="button"
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 3,
                            background: drawerOpen ? 'rgba(108, 99, 255, 0.08)' : 'transparent',
                            border: 'none',
                            color: drawerOpen ? C.primary : C.textMuted,
                            fontFamily: "'Plus Jakarta Sans', sans-serif",
                            fontSize: '0.66rem',
                            fontWeight: drawerOpen ? 800 : 600,
                            padding: '6px 4px',
                            borderRadius: 12,
                            flex: 1,
                            minWidth: 0,
                            cursor: 'pointer',
                            textAlign: 'center',
                        }}
                    >
                        <Menu size={20} />
                        <span>{t('more') || 'More'}</span>
                    </button>
                )}
            </nav>

            {/* Authority Slide-up Drawer Modal */}
            {isAuthority && drawerOpen && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 1100,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                    }}
                >
                    {/* Backdrop */}
                    <div
                        onClick={() => setDrawerOpen(false)}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'rgba(27, 29, 42, 0.55)',
                            backdropFilter: 'blur(6px)',
                            WebkitBackdropFilter: 'blur(6px)',
                        }}
                    />

                    {/* Drawer Content */}
                    <div
                        style={{
                            position: 'relative',
                            background: C.surface,
                            borderRadius: '24px 24px 0 0',
                            padding: '20px 20px calc(24px + env(safe-area-inset-bottom))',
                            boxShadow: '0 -12px 40px rgba(0, 0, 0, 0.25)',
                            maxHeight: '82vh',
                            overflowY: 'auto',
                            fontFamily: "'Plus Jakarta Sans', sans-serif",
                            animation: 'clay-slide-up 0.25s ease-out',
                        }}
                    >
                        {/* Drag Handle */}
                        <div
                            style={{
                                width: 44,
                                height: 5,
                                background: 'rgba(27, 29, 42, 0.15)',
                                borderRadius: 10,
                                margin: '0 auto 16px',
                            }}
                        />

                        {/* Officer Info Header */}
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                paddingBottom: 16,
                                borderBottom: `1px solid ${C.border}`,
                                marginBottom: 16,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <div
                                    style={{
                                        width: 42,
                                        height: 42,
                                        borderRadius: 14,
                                        background: 'linear-gradient(135deg, #6C63FF, #8B85FF)',
                                        color: '#FFFFFF',
                                        display: 'grid',
                                        placeItems: 'center',
                                        fontWeight: 800,
                                        fontSize: '1.1rem',
                                        boxShadow: '0 4px 12px rgba(108, 99, 255, 0.3)',
                                    }}
                                >
                                    {user.full_name?.charAt(0) || 'A'}
                                </div>
                                <div>
                                    <div style={{ fontWeight: 800, fontSize: '0.95rem', color: C.text }}>
                                        {user.full_name}
                                    </div>
                                    <div style={{ fontSize: '0.7rem', color: C.textMuted, fontWeight: 600 }}>
                                        {user.designation || 'Authority Officer'} · Online
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={() => setDrawerOpen(false)}
                                style={{
                                    background: C.surfaceAlt,
                                    border: `1px solid ${C.border}`,
                                    borderRadius: 12,
                                    width: 36,
                                    height: 36,
                                    display: 'grid',
                                    placeItems: 'center',
                                    cursor: 'pointer',
                                    color: C.text,
                                }}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Authority Navigation Links */}
                        <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textMuted, marginBottom: 10 }}>
                            {t('authorityTools') || 'Authority Tools & Rosters'}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
                            {authorityDrawerLinks.map((item) => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    onClick={() => setDrawerOpen(false)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        padding: '12px 14px',
                                        background: C.surfaceAlt,
                                        border: `1px solid ${C.border}`,
                                        borderRadius: 14,
                                        textDecoration: 'none',
                                        color: C.text,
                                        fontWeight: 700,
                                        fontSize: '0.8rem',
                                        boxShadow: '2px 2px 6px rgba(27,29,42,0.04)',
                                    }}
                                >
                                    {item.icon}
                                    <span style={{ flex: 1 }}>{item.label}</span>
                                    <ChevronRight size={14} color={C.textMuted} />
                                </NavLink>
                            ))}
                        </div>

                        {/* Language Selection */}
                        <div style={{ marginBottom: 16 }}>
                            <button
                                onClick={() => setLangOpen(!langOpen)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    width: '100%',
                                    padding: '12px 16px',
                                    background: C.surfaceAlt,
                                    border: `1px solid ${C.border}`,
                                    borderRadius: 14,
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                    fontSize: '0.82rem',
                                    color: C.text,
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <Globe size={16} color={C.primary} />
                                    <span>{t('language') || 'Language'}: {currentLang.nativeName}</span>
                                </div>
                                <span style={{ fontSize: '0.72rem', color: C.primary, fontWeight: 800 }}>Change</span>
                            </button>

                            {langOpen && (
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(2, 1fr)',
                                        gap: 6,
                                        marginTop: 8,
                                        padding: 8,
                                        background: C.surface,
                                        border: `1px solid ${C.border}`,
                                        borderRadius: 14,
                                        maxHeight: 180,
                                        overflowY: 'auto',
                                    }}
                                >
                                    {LANGUAGES.map((lang) => (
                                        <button
                                            key={lang.code}
                                            onClick={() => {
                                                setLanguage(lang.code);
                                                setLangOpen(false);
                                            }}
                                            style={{
                                                padding: '8px 10px',
                                                background: language === lang.code ? 'rgba(108,99,255,0.12)' : 'transparent',
                                                border: language === lang.code ? `1px solid ${C.primary}` : `1px solid transparent`,
                                                borderRadius: 10,
                                                cursor: 'pointer',
                                                fontSize: '0.75rem',
                                                fontWeight: language === lang.code ? 800 : 600,
                                                color: language === lang.code ? C.primary : C.text,
                                                textAlign: 'left',
                                            }}
                                        >
                                            {lang.nativeName}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Logout Button */}
                        <button
                            onClick={handleLogout}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 8,
                                width: '100%',
                                padding: '14px',
                                background: 'rgba(239, 68, 68, 0.08)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                borderRadius: 14,
                                color: C.critical,
                                fontWeight: 800,
                                fontSize: '0.85rem',
                                cursor: 'pointer',
                            }}
                        >
                            <LogOut size={16} />
                            <span>{t('logout') || 'Log Out'}</span>
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
