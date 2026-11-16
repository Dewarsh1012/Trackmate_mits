import { AnomalyFeatureMetrics } from './anomalyModel';
import { geminiJson } from './gemini';

interface GeminiAnomalySummaryInput {
    incidentType: string;
    severity: string;
    title: string;
    description: string;
    ruleScore: number;
    modelScore: number;
    hybridScore: number;
    metrics: AnomalyFeatureMetrics;
}

export interface GeminiAnomalyAssessment {
    /** Gemini's own 0..1 estimate that this is a genuine emergency. */
    score: number | null;
    summary: string | null;
}

const MAX_SUMMARY_CHARS = 360;

/** Asks Gemini to score the anomaly and write a triage summary in one call. */
export async function assessAnomalyWithGemini(payload: GeminiAnomalySummaryInput): Promise<GeminiAnomalyAssessment> {
    const result = await geminiJson<{ score?: number; summary?: string }>(buildPrompt(payload));
    if (!result) return { score: null, summary: null };

    const score = Number(result.score);
    const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
    return {
        score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
        summary: summary
            ? (summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 3)}...` : summary)
            : null,
    };
}

export async function generateGeminiAnomalySummary(payload: GeminiAnomalySummaryInput): Promise<string | null> {
    return (await assessAnomalyWithGemini(payload)).summary;
}

function buildPrompt(payload: GeminiAnomalySummaryInput): string {
    const { incidentType, severity, ruleScore, modelScore, hybridScore, metrics, description } = payload;
    return [
        'You assist an emergency-response authority dashboard for tourist safety.',
        'Assess whether the detected anomaly is likely a genuine emergency.',
        'Reply with JSON only: {"score": number between 0 and 1 (probability of a genuine emergency), "summary": string}.',
        'The summary is a triage note under 70 words with one recommended first action. No markdown, no bullets.',
        '',
        `Incident type: ${incidentType}`,
        `Severity: ${severity}`,
        `Rule score: ${ruleScore.toFixed(3)}`,
        `Model score: ${modelScore.toFixed(3)}`,
        `Hybrid score: ${hybridScore.toFixed(3)}`,
        `Description: ${description}`,
        `Metrics: inactivity=${metrics.inactivityMinutes.toFixed(1)}m, speed=${metrics.speedKmh.toFixed(1)}km/h, outsideZone=${metrics.isOutsideZone}, nearbyIncidents=${metrics.nearbyIncidents15m}, nearbyCritical=${metrics.nearbyCriticalIncidents15m}, userAnomalies24h=${metrics.userAnomalies24h}`,
    ].join('\n');
}
