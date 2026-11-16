/** Shared Web Audio helper: one context, unlocked by the first tap/click (browsers block sound before that). */
let ctx: AudioContext | null = null;
let unlockInstalled = false;

export function ensureAudio(): AudioContext | null {
    if (!ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
    }
    void ctx.resume();
    return ctx;
}

export function installAudioUnlock(): void {
    if (unlockInstalled) return;
    unlockInstalled = true;
    const unlock = () => { ensureAudio(); };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
}

/** Rising-and-falling hooter (police-siren style). Returns a function that stops it. */
export function startSiren(): () => void {
    const audio = ensureAudio();
    if (!audio) return () => undefined;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sawtooth';
    gain.gain.value = 0.28;
    osc.connect(gain).connect(audio.destination);
    osc.start();

    let stopped = false;
    const sweep = () => {
        if (stopped) return;
        const t = audio.currentTime;
        osc.frequency.cancelScheduledValues(t);
        osc.frequency.setValueAtTime(620, t);
        osc.frequency.linearRampToValueAtTime(1180, t + 0.7);
        osc.frequency.linearRampToValueAtTime(620, t + 1.4);
    };
    sweep();
    const timer = window.setInterval(sweep, 1400);
    return () => {
        stopped = true;
        window.clearInterval(timer);
        try { gain.gain.setTargetAtTime(0.0001, audio.currentTime, 0.05); osc.stop(audio.currentTime + 0.2); } catch { /* already stopped */ }
    };
}
