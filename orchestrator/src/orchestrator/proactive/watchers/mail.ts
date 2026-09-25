import type { CandidateEvent, MailWatcherConfig } from '../types';

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
