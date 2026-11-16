const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function isGeminiConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
}

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * Calls Gemini and parses a JSON reply. Returns null when no key is set or on any
 * failure, so callers can fall back to their local heuristics.
 */
export async function geminiJson<T = Record<string, unknown>>(prompt: string, timeoutMs?: number): Promise<T | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const timeout = timeoutMs ?? (Number(process.env.GEMINI_TIMEOUT_MS) || 6000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 1024,
                    responseMimeType: 'application/json',
                    thinkingConfig: { thinkingBudget: 0 },
                },
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            console.warn(`Gemini request failed: ${response.status}`);
            return null;
        }
        const data = (await response.json()) as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
        if (!text) return null;
        return JSON.parse(text.replace(/^```json\s*|```$/g, '')) as T;
    } catch (err) {
        console.warn('Gemini call error:', (err as Error).message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
