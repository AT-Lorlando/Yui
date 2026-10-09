// Client XTTS (voice/tts_engine.py, POST /tts) — partagé par /speak,
// /order (audio base64 de la réponse) et /voice/tts (mode appel de l'app).

const TTS_SERVER_URL =
    process.env.TTS_SERVER_URL ?? 'http://localhost:18770/tts';
const TTS_SPEAKER = process.env.XTTS_SPEAKER ?? 'Lilya Stainthorpe';
const TTS_SPEED = parseFloat(process.env.XTTS_SPEED ?? '1.0');

/** WAV synthétisé, ou null si le serveur XTTS ne répond pas (dégradation douce). */
export async function synthesizeWav(
    text: string,
    fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
    try {
        const res = await fetchImpl(TTS_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                language: 'fr',
                speaker: TTS_SPEAKER,
                speed: TTS_SPEED,
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
}

export async function generateTtsAudio(
    text: string,
): Promise<{ base64: string; mime: string } | null> {
    const wav = await synthesizeWav(text);
    return wav ? { base64: wav.toString('base64'), mime: 'audio/wav' } : null;
}
