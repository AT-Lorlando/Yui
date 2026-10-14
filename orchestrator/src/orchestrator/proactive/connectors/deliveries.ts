import { evaluateDeliveries } from '../watchers/deliveries';
import { listParcels } from '../../deliveries/tracker';
import { fromCandidate } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorContext, ConnectorDef } from '../connector';
import type { OrderStore } from '../mail/orders';
import type { Parcel } from '../../deliveries/tracker';
import type { ParcelStatus } from '../../deliveries/providers';

/** Colis en route : le mail du transporteur (date, suivi) vaut d'être guetté. */
const ON_THE_WAY: ReadonlySet<ParcelStatus> = new Set<ParcelStatus>([
    'shipped',
    'in_transit',
    'out_for_delivery',
]);
/** Un ordre de colis vit trois semaines au plus. */
const PARCEL_ORDER_DAYS = 21;

type ParcelOrders = Pick<OrderStore, 'all' | 'add' | 'byOrigin' | 'fulfill'>;

/**
 * Ordres de lecture automatiques (courrier v3) : un colis en route fait
 * guetter au lecteur IA le mail qui donne sa date, son transporteur et son
 * suivi — une seule fois par colis, quel que soit l'état de l'ordre ensuite
 * (satisfait ou expiré, il n'est pas reposé) ; la livraison le referme.
 */
export function syncParcelOrders(
    orders: ParcelOrders,
    parcels: Parcel[],
    now: number,
    log: ConnectorContext['log'],
): void {
    for (const p of parcels) {
        const origin = `parcel:${p.id}`;
        if (p.status === 'delivered') {
            const o = orders.byOrigin(origin);
            if (o) orders.fulfill(o.id, '', 'livré', now);
            continue;
        }
        if (!ON_THE_WAY.has(p.status)) continue;
        if (orders.all().some((o) => o.origin === origin)) continue;
        try {
            orders.add(
                {
                    text:
                        'Commande ' +
                        String(p.content ?? p.label ?? p.tracking) +
                        ' : extraire la date de livraison estimée, le transporteur et le numéro de suivi',
                    days: PARCEL_ORDER_DAYS,
                    source: 'connector',
                    origin,
                },
                now,
            );
        } catch (err) {
            log.warn(`deliveries: ordre ${origin} non posé — ${err}`);
        }
    }
}

export function deliveriesConnector(
    complete: (system: string, user: string) => Promise<string>,
    orders?: ParcelOrders,
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
            const events = (
                await evaluateDeliveries(ctx.callTool, cfg, complete)
            ).map((c) => fromCandidate(c, now));
            if (orders) syncParcelOrders(orders, listParcels(), now, ctx.log);
            return events;
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
