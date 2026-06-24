import Logger from '../../../logger';
import type { PresenceState } from '../../presence';
import type { CandidateEvent, ProactiveDeps, Watcher } from '../types';

interface Door {
    name?: string;
    state?: { stateName?: string };
}

export async function evaluatePresenceTransition(
    prev: PresenceState,
    next: PresenceState,
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
): Promise<CandidateEvent[]> {
    if (prev === 'home' && next === 'away') {
        const doors =
            ((await deviceHandler('list_doors')) as Door[] | null) ?? [];
        const open = doors
            .filter((d) => d.state?.stateName === 'unlocked')
            .map((d) => d.name ?? 'une porte');
        if (open.length > 0) {
            return [
                {
                    watcherId: 'presence',
                    subject: 'left-unlocked',
                    importance: 'urgent',
                    facts: `Jérémy vient de partir mais ces serrures sont déverrouillées : ${open.join(
                        ', ',
                    )}.`,
                },
            ];
        }
        return [];
    }
    if (prev === 'away' && next === 'home') {
        return [
            {
                watcherId: 'presence',
                subject: 'welcome-back',
                importance: 'info',
                facts: 'Jérémy vient de rentrer à la maison.',
            },
        ];
    }
    return [];
}

export function createPresenceWatcher(deps: ProactiveDeps): Watcher {
    return {
        id: 'presence',
        start(emit) {
            deps.subscribePresence((prev, next) => {
                void (async () => {
                    try {
                        Logger.info(
                            `proactive[presence]: transition ${prev} → ${next}`,
                        );
                        const events = await evaluatePresenceTransition(
                            prev,
                            next,
                            deps.deviceHandler,
                        );
                        Logger.info(
                            `proactive[presence]: ${events.length} candidat(s)` +
                                (events.length
                                    ? ` (${events
                                          .map((e) => e.subject)
                                          .join(', ')})`
                                    : ''),
                        );
                        for (const e of events) emit(e);
                    } catch (err) {
                        Logger.warn(`proactive[presence]: ${err}`);
                    }
                })();
            });
        },
        stop() {
            /* abonnement géré par PresenceManager ; rien à arrêter */
        },
    };
}
