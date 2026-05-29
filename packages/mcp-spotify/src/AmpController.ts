import * as broadlink from 'node-broadlink';
import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

const CODES_FILE = path.resolve(__dirname, '../../../data/broadlink-codes.json');
const STATE_FILE = path.resolve(__dirname, '../../../data/amp-state.json');

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

export class AmpController {
    private host: string;
    private device: any = null;
    private codes: AmpCodes;
    private connecting: Promise<void> | null = null;

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
            const found = devices.find((d: any) => d.host?.address === this.host);
            if (!found) throw new Error(`Broadlink RM4 Pro not found at ${this.host}`);
            await found.auth();
            this.device = found;
            Logger.info(`Broadlink connected to ${this.host}`);
        })().finally(() => { this.connecting = null; });

        return this.connecting;
    }

    private async sendCode(command: string): Promise<void> {
        await this.connect();
        const code = this.codes[command];
        if (!code) throw new Error(`Unknown amp command: ${command}`);
        await this.device.sendData(code);
    }

    async ensureOn(): Promise<void> {
        if (readState() === 'on') {
            Logger.info('Amp already on — skipping power toggle');
            return;
        }
        Logger.info('Amp off — sending power_toggle to turn on');
        await this.sendCode('power_toggle');
        writeState('on');
    }

    async turnOff(): Promise<void> {
        if (readState() === 'off') {
            Logger.info('Amp already off — skipping power toggle');
            return;
        }
        Logger.info('Amp on — sending power_toggle to turn off');
        await this.sendCode('power_toggle');
        writeState('off');
    }
}
