import { evaluatePresenceTransition } from '../watchers/presence';
import { fromCandidate } from '../events';
import type { Fact } from '../events';
import type { ConnectorDef } from '../connector';
import type { ProactiveDeps } from '../types';
import type { PresenceState } from '../../presence';

export function presenceConnector(
    subscribePresence: ProactiveDeps['subscribePresence'],
): ConnectorDef {
    return {
        id: 'presence',
        name: 'Présence',
        description:
            'Événements liés aux départs/arrivées (porte, lumières oubliées).',
        defaultEnabled: true,
        subscribe(ctx, emit) {
            return subscribePresence(
                (prev: PresenceState, next: PresenceState) => {
                    void (async () => {
                        try {
                            ctx.log.info(`transition ${prev} → ${next}`);
                            const events = await evaluatePresenceTransition(
                                prev,
                                next,
                                ctx.callTool,
                            );
                            for (const c of events)
                                emit(fromCandidate(c, ctx.now()));
                        } catch (err) {
                            ctx.log.warn(String(err));
                        }
                    })();
                },
            );
        },
        async snapshot(ctx): Promise<Fact[]> {
            return [
                {
                    label: 'Présence',
                    value: ctx.presence() === 'home' ? 'à la maison' : 'absent',
                },
            ];
        },
    };
}
