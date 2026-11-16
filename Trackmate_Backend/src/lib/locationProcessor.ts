import { Incident, LocationLog, Zone, Profile, Presence } from '../models';
import { findZoneForPoint, distanceToZoneEdgeMeters } from './geofence';
import { computeAreaSafety } from './areaSafety';
import type { Emitter } from './realtime';

export interface LocationUpdate {
    userId: string;
    latitude: number;
    longitude: number;
    accuracy?: number;
    speed?: number;
    battery?: number;
    role?: string;
    name?: string;
}

const SAVE_EVERY_MS = 25_000;
const PROXIMITY_THRESHOLD_M = 500;

/**
 * Shared handler for live location pings (Socket.IO `location_update` and the
 * HTTP realtime endpoint). State lives in the DB so it works across serverless
 * invocations.
 */
export async function processLocationUpdate(io: Emitter, data: LocationUpdate): Promise<void> {
    if (!data || !data.userId || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) return;
    const now = new Date();

    const [zones, presence] = await Promise.all([
        Zone.find({ is_active: true }).lean(),
        Presence.findOneAndUpdate(
            { user: data.userId },
            { $set: { last_seen: now, offline_notified: false } },
            { upsert: true, new: false }
        ).lean() as Promise<any>,
    ]);

    const matchingZone = findZoneForPoint(data.latitude, data.longitude, zones as any);
    const currentZoneId = matchingZone ? String(matchingZone._id) : null;
    const previousZoneId: string | null = presence?.zone ?? null;

    const lastSaved = presence?.last_saved ? new Date(presence.last_saved).getTime() : 0;
    const shouldSave = now.getTime() - lastSaved >= SAVE_EVERY_MS;
    if (shouldSave) {
        await Promise.all([
            LocationLog.create({
                user: data.userId,
                latitude: data.latitude,
                longitude: data.longitude,
                accuracy_meters: data.accuracy,
                speed: data.speed,
                battery_level: data.battery,
                is_in_safe_zone: matchingZone ? matchingZone.risk_level === 'safe' : false,
                current_zone: matchingZone ? matchingZone._id : undefined,
                source: 'gps',
                recorded_at: now,
            }),
            Presence.updateOne({ user: data.userId }, { $set: { last_saved: now } }),
        ]);
    }

    if (currentZoneId !== previousZoneId) {
        await Presence.updateOne({ user: data.userId }, { $set: { zone: currentZoneId } });

        if (currentZoneId && matchingZone) {
            io.to(`user_${data.userId}`).emit('zone_alert', {
                type: 'entered',
                zone: { id: currentZoneId, name: matchingZone.name, risk_level: matchingZone.risk_level },
                message: `You have entered ${matchingZone.name} (${matchingZone.risk_level} zone)`,
            });

            if (matchingZone.risk_level === 'high' || matchingZone.risk_level === 'restricted') {
                io.to('authority_room').emit('zone_breach', {
                    userId: data.userId,
                    zone: { id: currentZoneId, name: matchingZone.name, risk_level: matchingZone.risk_level },
                    latitude: data.latitude,
                    longitude: data.longitude,
                    timestamp: now.toISOString(),
                });
                // One penalty per breach: re-entering the same zone within the dedupe window (GPS jitter
                // at a boundary, overlapping zones) must not keep draining the score.
                const newBreach = data.role === 'tourist'
                    ? await recordGeofenceBreach(io, data, matchingZone, now)
                    : true;
                const deduction = newBreach ? (matchingZone.risk_level === 'restricted' ? -5 : -2) : 0;
                // Pipeline update keeps the score within 0..100 (a plain $inc can go negative).
                const updated = deduction === 0 ? null : await Profile.findByIdAndUpdate(
                    data.userId,
                    [{ $set: { safety_score: { $max: [0, { $min: [100, { $add: ['$safety_score', deduction] }] }] } } }],
                    { new: true }
                ).select('safety_score').lean();
                if (updated) io.to(`user_${data.userId}`).emit('safety_score', { score: (updated as any).safety_score, reason: `Entered ${matchingZone.name}` });
            }
        } else if (!currentZoneId && previousZoneId) {
            io.to(`user_${data.userId}`).emit('zone_alert', {
                type: 'exited',
                zone: null,
                message: 'You are now outside all registered zones',
            });
        }
    }

    // Early warning: within 500 m of a high/restricted zone (circle or drawn polygon) but not inside one.
    // Announced once per approach, not on every ping.
    let nearestDanger: { zone: any; edge: number } | null = null;
    if (!matchingZone || (matchingZone.risk_level !== 'high' && matchingZone.risk_level !== 'restricted')) {
        for (const dz of zones as any[]) {
            if (dz.risk_level !== 'high' && dz.risk_level !== 'restricted') continue;
            const edge = distanceToZoneEdgeMeters(data.latitude, data.longitude, dz);
            if (edge > 0 && edge <= PROXIMITY_THRESHOLD_M && (!nearestDanger || edge < nearestDanger.edge)) {
                nearestDanger = { zone: dz, edge };
            }
        }
    }
    const proximityZoneId = nearestDanger ? String(nearestDanger.zone._id) : null;
    if (nearestDanger && proximityZoneId !== (presence?.proximity_zone ?? null)) {
        const dz = nearestDanger.zone;
        io.to(`user_${data.userId}`).emit('red_zone_proximity', {
            zone: { id: String(dz._id), name: dz.name, risk_level: dz.risk_level },
            distance_meters: Math.round(nearestDanger.edge),
            message: `⚠️ You are ${Math.round(nearestDanger.edge)}m from ${dz.name} (${dz.risk_level} zone). Stay alert!`,
            timestamp: now.toISOString(),
        });
    }
    if (proximityZoneId !== (presence?.proximity_zone ?? null)) {
        await Presence.updateOne({ user: data.userId }, { $set: { proximity_zone: proximityZoneId } });
    }

    // Position-based safety score, pushed to the user and shown to authorities.
    const areaSafety = await computeAreaSafety(data.latitude, data.longitude, matchingZone as any).catch(() => null);
    if (areaSafety) io.to(`user_${data.userId}`).emit('area_safety', areaSafety);

    io.to('authority_room').emit('location:update', {
        userId: data.userId,
        role: data.role,
        name: data.name,
        latitude: data.latitude,
        longitude: data.longitude,
        zone: matchingZone ? { id: matchingZone._id, name: matchingZone.name, risk_level: matchingZone.risk_level } : null,
        area_safety: areaSafety ? { score: areaSafety.score, level: areaSafety.level } : null,
        timestamp: now.toISOString(),
    });

    // Crisis-timeline movement pings for active SOS incidents involving this user.
    if (shouldSave) {
        const sos = await Incident.find({
            incident_type: 'sos_emergency',
            status: { $in: ['active', 'acknowledged', 'assigned', 'escalated'] },
            created_at: { $gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
            $or: [{ reporter: data.userId }, { assigned_to: data.userId }],
        }).select('_id').limit(4).lean();

        for (const incident of sos) {
            const incidentId = String(incident._id);
            io.to('authority_room').to(`incident_${incidentId}`).emit('crisis:timeline', {
                incident_id: incidentId,
                events: [{
                    event_id: `loc_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
                    type: 'live_location_ping',
                    label: 'Live location update received',
                    timestamp: now.toISOString(),
                    actor_role: data.role || 'user',
                    actor_id: data.userId,
                    details: {
                        latitude: data.latitude,
                        longitude: data.longitude,
                        zone: matchingZone
                            ? { id: String(matchingZone._id), name: matchingZone.name, risk_level: matchingZone.risk_level }
                            : null,
                    },
                }],
            });
        }
    }
}

const BREACH_DEDUPE_MS = 30 * 60 * 1000;

/** Entering a high-risk/restricted zone becomes an incident authorities see (once per 30 min per person and zone). */
async function recordGeofenceBreach(io: Emitter, data: LocationUpdate, zone: any, now: Date): Promise<boolean> {
    const zoneId = String(zone._id);
    const recent = await Incident.exists({
        reporter: data.userId,
        incident_type: 'zone_breach',
        'metadata.zone_id': zoneId,
        created_at: { $gte: new Date(now.getTime() - BREACH_DEDUPE_MS) },
    });
    if (recent) return false;

    const restricted = zone.risk_level === 'restricted';
    const created = await Incident.create({
        reporter: data.userId,
        incident_type: 'zone_breach',
        title: `${restricted ? 'Restricted' : 'High-risk'} zone entered: ${zone.name}`,
        description: `${data.name || 'A tourist'} entered ${zone.name} (${zone.risk_level} zone).`,
        latitude: data.latitude,
        longitude: data.longitude,
        zone: zone._id,
        severity: restricted ? 'high' : 'medium',
        source: 'zone_breach',
        is_public: false,
        metadata: { zone_id: zoneId, zone_risk_level: zone.risk_level, geofence: true },
    });
    const full = await Incident.findById(created._id)
        .populate('reporter', 'full_name role blockchain_id phone')
        .populate('zone', 'name risk_level')
        .lean();
    io.to('authority_room').emit('incident:new', full);
    io.to('authority_room').emit('new-incident', full);
    return true;
}
