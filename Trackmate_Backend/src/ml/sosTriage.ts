import { clamp, round } from './math';
import { LogisticModel, predict, presentFactors, priorModel } from './logistic';

/**
 * SOS triage: for every SOS, estimate (1) how likely it is a genuine emergency, (2) what kind of
 * emergency it looks like from the text, and (3) a response priority. It never dismisses an SOS:
 * a likely false alarm is ranked lower, not hidden, and every score comes with reasons.
 */

export const TRIAGE_CATEGORIES = ['medical', 'crime', 'accident', 'harassment', 'lost', 'disaster'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number] | 'unspecified';

// ── Text: naive Bayes seeded with a lexicon (English + common Hinglish), refined from resolved incidents ──

const LEXICON: Record<(typeof TRIAGE_CATEGORIES)[number], string[]> = {
    medical: ['heart', 'chest', 'pain', 'bleeding', 'blood', 'faint', 'fainted', 'unconscious', 'breathing', 'breathe', 'seizure', 'injury', 'injured', 'ambulance', 'sick', 'vomit', 'vomiting', 'fever', 'dizzy', 'collapsed', 'medical', 'doctor', 'hospital', 'allergic', 'allergy', 'snake', 'bite', 'bitten', 'altitude', 'oxygen', 'dard', 'bimar', 'khoon', 'behosh'],
    crime: ['robbed', 'robbery', 'theft', 'stolen', 'stole', 'thief', 'knife', 'gun', 'attack', 'attacked', 'assault', 'mugged', 'kidnap', 'kidnapped', 'threat', 'threatened', 'weapon', 'loot', 'scam', 'cheated', 'fraud', 'followed', 'chori', 'dacoit'],
    harassment: ['harass', 'harassed', 'harassment', 'molest', 'molested', 'stalk', 'stalking', 'stalker', 'teasing', 'touching', 'abuse', 'abused', 'uncomfortable', 'drunk', 'drunken', 'unsafe', 'groped'],
    accident: ['accident', 'crash', 'crashed', 'collision', 'overturned', 'skid', 'skidded', 'fell', 'fall', 'fallen', 'slipped', 'fracture', 'broken', 'vehicle', 'car', 'bike', 'bus', 'truck', 'gaadi'],
    lost: ['lost', 'missing', 'stranded', 'stuck', 'trapped', 'trail', 'route', 'direction', 'dark', 'separated', 'wandered', 'khoya', 'rasta', 'wrong', 'path'],
    disaster: ['fire', 'flood', 'landslide', 'earthquake', 'avalanche', 'storm', 'cyclone', 'smoke', 'burning', 'collapse', 'rockfall', 'cloudburst', 'lightning', 'aag', 'baadh'],
};
const URGENT_WORDS = ['help', 'urgent', 'please', 'immediately', 'dying', 'scared', 'danger', 'dangerous', 'quick', 'hurry', 'madad', 'bachao', 'save'];
const FALSE_WORDS = ['test', 'testing', 'mistake', 'mistakenly', 'accidentally', 'pressed', 'sorry', 'oops', 'nothing', 'fine', 'okay', 'galti', 'demo', 'trial'];

const SEED_COUNT = 4;
const ALPHA = 0.5;

export interface TextModel {
    class_docs: Record<string, number>;
    counts: Record<string, Record<string, number>>;
}

/** Light suffix stripping so "following", "followed" and "follows" match the same word. */
export function stem(t: string): string {
    if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
}

export function tokenize(text: string): string[] {
    return (text || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3 && t.length <= 20).map(stem);
}

export function seedTextModel(): TextModel {
    const model: TextModel = { class_docs: {}, counts: {} };
    for (const cat of TRIAGE_CATEGORIES) {
        model.class_docs[cat] = 5;
        model.counts[cat] = {};
        for (const w of LEXICON[cat]) model.counts[cat][stem(w)] = SEED_COUNT;
    }
    return model;
}

/** Adds labelled examples on top of the lexicon seed. Vocabulary is capped so the stored model stays small. */
export function trainTextModel(examples: Array<{ text: string; category: (typeof TRIAGE_CATEGORIES)[number] }>, maxVocab = 2500): TextModel {
    const model = seedTextModel();
    const total = new Map<string, number>();
    for (const ex of examples) {
        model.class_docs[ex.category] = (model.class_docs[ex.category] ?? 0) + 1;
        for (const tok of new Set(tokenize(ex.text))) {
            model.counts[ex.category][tok] = (model.counts[ex.category][tok] ?? 0) + 1;
            total.set(tok, (total.get(tok) ?? 0) + 1);
        }
    }
    const keep = new Set<string>(TRIAGE_CATEGORIES.flatMap((c) => LEXICON[c].map(stem)));
    [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxVocab).forEach(([w, n]) => { if (n >= 2) keep.add(w); });
    for (const cat of Object.keys(model.counts)) {
        for (const w of Object.keys(model.counts[cat])) if (!keep.has(w)) delete model.counts[cat][w];
    }
    return model;
}

export function classifyText(model: TextModel, text: string): { category: TriageCategory; probs: Record<string, number>; matched: string[] } {
    const vocab = new Set<string>();
    for (const cat of Object.keys(model.counts)) for (const w of Object.keys(model.counts[cat])) vocab.add(w);
    const tokens = [...new Set(tokenize(text))].filter((t) => vocab.has(t));
    const cats = Object.keys(model.counts);
    if (!tokens.length) return { category: 'unspecified', probs: {}, matched: [] };

    const totalDocs = cats.reduce((s, c) => s + model.class_docs[c], 0);
    const logs = cats.map((cat) => {
        const wordTotal = Object.values(model.counts[cat]).reduce((a, b) => a + b, 0);
        let lp = Math.log(model.class_docs[cat] / totalDocs);
        for (const t of tokens) lp += Math.log(((model.counts[cat][t] ?? 0) + ALPHA) / (wordTotal + ALPHA * vocab.size));
        return lp;
    });
    const maxLog = Math.max(...logs);
    const exps = logs.map((l) => Math.exp(l - maxLog));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs: Record<string, number> = {};
    cats.forEach((c, i) => { probs[c] = round(exps[i] / sum, 4); });
    const best = cats.reduce((a, b) => (probs[a] >= probs[b] ? a : b));
    return { category: probs[best] >= 0.4 ? (best as TriageCategory) : 'unspecified', probs, matched: tokens };
}

// ── Context: is this SOS likely genuine? ─────────────────────────────────────

export const TRIAGE_FEATURES = [
    'danger_zone', 'outside_zone', 'night', 'health_flag', 'low_battery', 'behaviour', 'nearby_incidents',
    'earlier_alerts', 'repeat_sos', 'false_alarm_history', 'rapid_repeat', 'urgent_text', 'false_hint_text',
    'has_detail', 'specific_emergency', 'silence',
] as const;

export interface TriageInputs {
    text: string;
    zoneRisk: number; // 0..1, 0 when outside all zones
    outsideZone: boolean;
    hour: number;
    healthFlag: boolean;
    battery?: number;
    behaviourScore: number;
    nearbyIncidents15m: number;
    anomalies24h: number;
    sosLast24h: number;
    falseAlarmRate7d: number;
    minutesSinceLastSos: number;
    silenceMin: number;
}

export function buildTriageVector(i: TriageInputs, text: { category: TriageCategory; probs: Record<string, number> }): number[] {
    const tokens = new Set(tokenize(i.text));
    const urgent = URGENT_WORDS.filter((w) => tokens.has(stem(w))).length;
    const falseHint = FALSE_WORDS.some((w) => tokens.has(stem(w))) ? 1 : 0;
    const specific = text.category !== 'unspecified' ? 1 : 0;
    return [
        clamp(i.zoneRisk, 0, 1),
        i.outsideZone ? 1 : 0,
        i.hour >= 22 || i.hour < 5 ? 1 : 0,
        i.healthFlag ? 1 : 0,
        i.battery == null ? 0 : i.battery < 20 ? 1 : i.battery < 40 ? 0.5 : 0,
        clamp((i.behaviourScore - 0.55) / 0.35, 0, 1),
        clamp(i.nearbyIncidents15m / 4, 0, 1),
        clamp(i.anomalies24h / 3, 0, 1),
        clamp((i.sosLast24h - 1) / 3, 0, 1),
        clamp(i.falseAlarmRate7d, 0, 1),
        i.minutesSinceLastSos < 20 ? 1 : 0,
        clamp(urgent / 2, 0, 1),
        falseHint,
        (i.text || '').trim().length > 15 ? 1 : 0,
        specific,
        clamp(i.silenceMin / 60, 0, 1),
    ];
}

/** Domain constraints: stress signals can only raise genuine-likelihood; misuse signals can only lower it. */
export const TRIAGE_SIGNS: Array<1 | -1 | 0> = [1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, 1, -1, 0, 1, 0];

export const TRIAGE_PRIOR: LogisticModel = priorModel(
    [...TRIAGE_FEATURES],
    [0.9, 0.3, 0.4, 1.8, 0.3, 1.2, 0.8, 0.6, -0.9, -2.0, -1.2, 1.0, -2.5, 0.3, 0.6, 0.4],
    0.45
);

/** What each feature means when it is present. The learned weight decides whether it supports or doubts a genuine emergency. */
const FEATURE_LABELS: Record<(typeof TRIAGE_FEATURES)[number], string> = {
    danger_zone: 'Sent from a high-risk zone',
    outside_zone: 'Outside all monitored zones',
    night: 'Sent at night',
    health_flag: 'Vital signs outside the normal range',
    low_battery: 'Phone battery is low',
    behaviour: 'Movement was out of character before the SOS',
    nearby_incidents: 'Other incidents reported nearby',
    earlier_alerts: 'Earlier alerts for this person today',
    repeat_sos: 'Repeated SOS presses',
    false_alarm_history: 'History of false alarms',
    rapid_repeat: 'Another SOS within 20 minutes',
    urgent_text: 'Message uses urgent wording',
    false_hint_text: 'Message suggests a mistake or test',
    has_detail: 'Includes a description',
    specific_emergency: 'Message describes a specific emergency',
    silence: 'Location updates went quiet before the SOS',
};

export interface TriageResult {
    p_genuine: number;
    p_false_alarm: number;
    p_ml: number;
    p_gemini: number | null;
    category: TriageCategory;
    category_probs: Record<string, number>;
    priority: 'P1' | 'P2' | 'P3' | 'P4';
    suggested_severity: 'critical' | 'high' | 'medium' | 'low';
    action: string;
    reasons: Array<{ label: string; effect: 'supports' | 'doubts' }>;
    model_version: string;
    text_model_version: string;
    source: 'prior' | 'trained';
    vector: number[];
}

const LIFE_THREAT = new Set<TriageCategory>(['medical', 'crime', 'accident', 'disaster']);

export function triageSos(
    inputs: TriageInputs,
    models: { genuine: LogisticModel; genuineSource: 'prior' | 'trained'; genuineVersion: string; text: TextModel; textVersion: string },
    geminiScore: number | null = null
): TriageResult {
    const text = classifyText(models.text, inputs.text);
    const x = buildTriageVector(inputs, text);
    const pMl = predict(models.genuine, x);
    const p = geminiScore != null && Number.isFinite(geminiScore) ? 0.75 * pMl + 0.25 * clamp(geminiScore, 0, 1) : pMl;

    let priority: TriageResult['priority'];
    if (p >= 0.7 || (inputs.healthFlag && p >= 0.45) || (LIFE_THREAT.has(text.category) && p >= 0.55)) priority = 'P1';
    else if (p >= 0.5) priority = 'P2';
    else if (p >= 0.3) priority = 'P3';
    else priority = 'P4';

    const actions: Record<TriageResult['priority'], string> = {
        P1: 'Dispatch the nearest responder now and call the tourist.',
        P2: 'Assign a responder and try to reach the tourist.',
        P3: 'Call the tourist to confirm before dispatching.',
        P4: 'Likely a false alarm. Verify with a call; keep the incident open until confirmed.',
    };
    const severity = { P1: 'critical', P2: 'high', P3: 'medium', P4: 'low' } as const;

    const reasons: TriageResult['reasons'] = presentFactors(models.genuine, x, 0.25)
        .slice(0, 5)
        .map((f) => ({ label: FEATURE_LABELS[TRIAGE_FEATURES[f.index]], effect: f.sign === 1 ? 'supports' as const : 'doubts' as const }));
    if (text.category !== 'unspecified' && !reasons.some((r) => r.label === FEATURE_LABELS.specific_emergency)) {
        reasons.unshift({ label: `Message reads like a ${text.category.replace('_', ' ')} emergency`, effect: 'supports' });
    }
    if (!reasons.length) reasons.push({ label: 'No strong signals either way; treat as a normal SOS', effect: 'supports' });

    return {
        p_genuine: round(p, 4),
        p_false_alarm: round(1 - p, 4),
        p_ml: round(pMl, 4),
        p_gemini: geminiScore != null && Number.isFinite(geminiScore) ? round(clamp(geminiScore, 0, 1), 4) : null,
        category: text.category,
        category_probs: text.probs,
        priority,
        suggested_severity: severity[priority],
        action: actions[priority],
        reasons: reasons.slice(0, 5),
        model_version: models.genuineVersion,
        text_model_version: models.textVersion,
        source: models.genuineSource,
        vector: x.map((v) => round(v, 4)),
    };
}
