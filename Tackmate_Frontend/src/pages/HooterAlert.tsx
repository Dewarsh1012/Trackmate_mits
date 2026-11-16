import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { HooterScreen } from '../components/alerts/HooterOverlay';

/**
 * Public hooter page, opened from a link an authority shares (Quick Share / Bluetooth, SMS, WhatsApp, QR).
 * No sign-in needed: it flashes at once and sounds the siren on the first tap.
 */
export default function HooterAlert() {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const hooter = useMemo(() => ({
        hooter_id: 'link',
        message: (params.get('m') || '').slice(0, 200) || null,
        issued_by: 'Authority',
    }), [params]);

    return <HooterScreen hooter={hooter} requireTap onAcknowledge={() => navigate('/', { replace: true })} />;
}
