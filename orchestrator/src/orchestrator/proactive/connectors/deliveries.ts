import { evaluateDeliveries } from '../watchers/deliveries';
import { listParcels } from '../../deliveries/tracker';
import { fromCandidate } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef } from '../connector';

export function deliveriesConnector(
    complete: (system: string, user: string) => Promise<string>,
): ConnectorDef {
    return {
        id: 'deliveries',
        name: 'Livraisons',
        description:
            'Suivi de colis (transporteurs + contenu) et notifications de statut.',
        defaultEnabled: true,
        pollMinutes: 30,
        settings: [
            {
                key: 'pollMinutes',
                label: 'Intervalle (min)',
                type: 'number',
                default: 30,
            },
            {
                key: 'query',
                label: 'Requête Gmail (vide = défaut)',
                type: 'string',
                default: '',
            },
            {
                key: 'maxPerHour',
                label: 'Max événements / heure',
                type: 'number',
                default: 6,
            },
        ],
        async events(ctx): Promise<Event[]> {
            const now = ctx.now();
            const query = String(ctx.settings.query ?? '').trim();
            const cfg = {
                pollMinutes: Number(ctx.settings.pollMinutes ?? 30),
                ...(query ? { query } : {}),
            };
            return (await evaluateDeliveries(ctx.callTool, cfg, complete)).map(
                (c) => fromCandidate(c, now),
            );
        },
        async snapshot(ctx): Promise<Fact[]> {
            const now = ctx.now();
            return listParcels()
                .filter(
                    (p) =>
                        p.status !== 'delivered' ||
                        now - p.updatedAt < 12 * 3600_000,
                )
                .slice(0, 8)
                .map((p) => ({
                    label: 'Colis',
                    value: `${String(
                        p.content ?? p.label ?? p.tracking ?? 'colis',
                    )} (${String(p.status ?? '?')})`,
                }));
        },
    };
}
