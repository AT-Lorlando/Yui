import * as broadlink from 'node-broadlink';
import * as fs from 'fs';
import Logger from './logger';
import { dataPath } from '@yui/shared';
import { AMP_SETTLE_MS, settleDelay } from './ampSettle';

const CODES_FILE = dataPath('broadlink-codes.json');
const STATE_FILE = dataPath('amp-state.json');

type AmpCodes = Record<string, string>;

function readState(): 'on' | 'off' {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        return s.marantz_amp === 'on' ? 'on' : 'off';
    } catch {
        return 'off';
    }
}

function writeState(state: 'on' | 'off'): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ marantz_amp: state }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AmpController {
    private host: string;
    private device: any = null;
    private codes: AmpCodes;
    private connecting: Promise<void> | null = null;
    // Les ordres de puissance sont SÉRIALISÉS et espacés d'AMP_SETTLE_MS :
    // deux toggles rapprochés (ON puis OFF depuis l'app) partaient en
    // parallèle, le second était ignoré par l'ampli encore en train de
    // s'allumer, et l'état persisté disait « off » devant un ampli allumé.
    private queue: Promise<unknown> = Promise.resolve();
    private lastToggleAt = 0;

    constructor(host: string) {
        this.host = host;
        const raw = JSON.parse(fs.readFileSync(CODES_FILE, 'utf-8'));
        this.codes = raw.marantz_amp as AmpCodes;
    }

    async connect(): Promise<void> {
        if (this.device) return;
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
            const devices = await broadlink.discover(3000);
            const found = devices.find(
                (d: any) => d.host?.address === this.host,
            );
            if (!found)
                throw new Error(`Broadlink RM4 Pro not found at ${this.host}`);
            await found.auth();
            this.device = found;
            Logger.info(`Broadlink connected to ${this.host}`);
        })().finally(() => {
            this.connecting = null;
        });

        return this.connecting;
    }

    private async sendCode(command: string): Promise<void> {
        await this.connect();
        const code = this.codes[command];
        if (!code) throw new Error(`Unknown amp command: ${command}`);
        await this.device.sendData(code);
    }

    private run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.queue.then(fn, fn);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async setPower(target: 'on' | 'off'): Promise<void> {
        if (readState() === target) {
            Logger.info(`Amp already ${target} — skipping power toggle`);
            return;
        }
        const wait = settleDelay(this.lastToggleAt, Date.now(), AMP_SETTLE_MS);
        if (wait > 0) {
            Logger.info(
                `Amp settling — waiting ${wait} ms before power toggle`,
            );
            await sleep(wait);
        }
        Logger.info(
            `Amp ${
                target === 'on' ? 'off' : 'on'
            } — sending power_toggle to turn ${target}`,
        );
        await this.sendCode('power_toggle');
        this.lastToggleAt = Date.now();
        writeState(target);
    }

    ensureOn(): Promise<void> {
        return this.run(() => this.setPower('on'));
    }

    turnOff(): Promise<void> {
        return this.run(() => this.setPower('off'));
    }
}
