import Logger from '../../../logger';
import type {
    CandidateEvent,
    MailWatcherConfig,
    ProactiveDeps,
    Watcher,
} from '../types';

const MAIL_COOLDOWN_MS = 6 * 60 * 60_000; // 6 h : on ne re-signale pas trop souvent
// Borne la taille du résumé Gmail injecté dans le prompt LLM (coût tokens).
const MAX_FACTS_CHARS = 1000;

export async function evaluateMail(
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
    cfg: MailWatcherConfig,
): Promise<CandidateEvent[]> {
    const result = await deviceHandler('search_emails', { query: cfg.query });
    if (typeof result !== 'string') return [];
    if (result.startsWith('Aucun email')) return [];
    const summary =
        result.length > MAX_FACTS_CHARS
            ? result.slice(0, MAX_FACTS_CHARS) + '…'
            : result;
    return [
        {
            watcherId: 'mail',
            subject: 'important-mail',
            importance: 'utile',
            facts: `Mails importants non lus : ${summary}`,
            cooldownMs: MAIL_COOLDOWN_MS,
        },
    ];
}

export function createMailWatcher(
    cfg: MailWatcherConfig,
    deps: ProactiveDeps,
): Watcher {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async (emit: (c: CandidateEvent) => void): Promise<void> => {
        try {
            const events = await evaluateMail(deps.deviceHandler, cfg);
            Logger.info(`proactive[mail]: poll → ${events.length} candidat(s)`);
            for (const e of events) emit(e);
        } catch (err) {
            Logger.warn(`proactive[mail]: ${err}`);
        }
    };
    return {
        id: 'mail',
        start(emit) {
            void tick(emit);
            timer = setInterval(
                () => void tick(emit),
                cfg.pollMinutes * 60_000,
            );
        },
        stop() {
            if (timer) clearInterval(timer);
        },
    };
}
