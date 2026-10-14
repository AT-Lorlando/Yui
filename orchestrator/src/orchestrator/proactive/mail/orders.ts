import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';

export type OrderSource = 'user' | 'voice' | 'connector';
export type OrderState = 'active' | 'fulfilled' | 'expired';

export interface MailOrder {
    id: string;
    text: string;
    createdAt: number;
    expiresAt: number;
    source: OrderSource;
    origin?: string;
    state: OrderState;
    fulfilledAt?: number;
    fulfilledBy?: string;
    result?: string;
}

export const ORDER_DEFAULT_DAYS = 14;
export const ORDER_TEXT_MAX = 300;
export const ORDERS_MAX = 40;

const DAY_MS = 86_400_000;

/** Pur : un ordre actif échu (expiresAt ≤ now) passe à `expired`. */
export function expireOrders(orders: MailOrder[], now: number): MailOrder[] {
    return orders.map((o) =>
        o.state === 'active' && o.expiresAt <= now
            ? { ...o, state: 'expired' as const }
            : o,
    );
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** Une ligne par ordre actif : "- [o-3] texte (jusqu'au 28/10)". */
export function ordersPrompt(orders: MailOrder[]): string {
    return orders
        .filter((o) => o.state === 'active')
        .map((o) => {
            const d = new Date(o.expiresAt);
            return `- [${o.id}] ${o.text} (jusqu'au ${pad(d.getDate())}/${pad(
                d.getMonth() + 1,
            )})`;
        })
        .join('\n');
}

export class OrderStore {
    private path: string;
    private data: MailOrder[] = [];

    constructor(file?: string) {
        this.path = file ?? dataPath('mail-orders.json');
        this.load();
    }

    all(): MailOrder[] {
        return this.data;
    }

    /** Expire au passage (et sauve si quelque chose a changé). */
    active(now: number): MailOrder[] {
        const next = expireOrders(this.data, now);
        if (next.some((o, i) => o !== this.data[i])) {
            this.data = next;
            this.save();
        }
        return this.data.filter((o) => o.state === 'active');
    }

    add(
        input: {
            text: string;
            days?: number;
            source: OrderSource;
            origin?: string;
        },
        now: number,
    ): MailOrder {
        const text = input.text.trim();
        if (!text) throw new Error("Le texte de l'ordre est vide");
        if (text.length > ORDER_TEXT_MAX) {
            throw new Error(
                `Le texte de l'ordre dépasse ${ORDER_TEXT_MAX} caractères`,
            );
        }
        const expiresAt = now + (input.days ?? ORDER_DEFAULT_DAYS) * DAY_MS;
        const active = this.active(now);

        if (input.origin) {
            const existing = active.find((o) => o.origin === input.origin);
            if (existing) {
                existing.text = text;
                existing.expiresAt = expiresAt;
                this.save();
                return existing;
            }
        }
        if (active.length >= ORDERS_MAX) {
            throw new Error(`Trop d'ordres actifs (maximum ${ORDERS_MAX})`);
        }
        const order: MailOrder = {
            id: 'o-' + crypto.randomBytes(3).toString('hex'),
            text,
            createdAt: now,
            expiresAt,
            source: input.source,
            state: 'active',
        };
        if (input.origin) order.origin = input.origin;
        this.data.push(order);
        this.save();
        return order;
    }

    fulfill(
        id: string,
        mailId: string,
        result: string | undefined,
        now: number,
    ): MailOrder | null {
        const o = this.data.find((x) => x.id === id);
        if (!o) return null;
        o.state = 'fulfilled';
        o.fulfilledAt = now;
        o.fulfilledBy = mailId;
        if (result !== undefined) o.result = result;
        this.save();
        return o;
    }

    remove(id: string): boolean {
        const i = this.data.findIndex((x) => x.id === id);
        if (i < 0) return false;
        this.data.splice(i, 1);
        this.save();
        return true;
    }

    /** Ordre ACTIF portant cette origine. */
    byOrigin(origin: string): MailOrder | null {
        return (
            this.data.find(
                (o) => o.origin === origin && o.state === 'active',
            ) ?? null
        );
    }

    private load(): void {
        if (!fs.existsSync(this.path)) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
            if (!Array.isArray(raw)) throw new Error('tableau attendu');
            this.data = raw.filter(
                (o) =>
                    o &&
                    typeof o.id === 'string' &&
                    typeof o.text === 'string' &&
                    typeof o.expiresAt === 'number',
            );
        } catch (e) {
            Logger.warn(`mail-orders.json illisible, réinitialisation : ${e}`);
            this.data = [];
        }
    }

    save(): void {
        try {
            fs.mkdirSync(path.dirname(this.path), { recursive: true });
            fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch (e) {
            Logger.warn(`mail-orders.json non écrit : ${e}`);
        }
    }
}
