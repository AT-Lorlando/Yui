import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig } from './types';
import Logger from '../../logger';

const CONFIG_FILE = path.resolve(process.cwd(), 'data/proactive.json');

export const DEFAULT_CONFIG: ProactiveConfig = {
    enabled: false,
    chattiness: 'normal',
    quietHours: { start: '23:00', end: '07:00' },
    digestTime: '07:00',
    defaultCooldownMin: 30,
    automationGuardWindowMin: 60,
    whitelist: [],
};

export function mergeConfig(raw: unknown): ProactiveConfig {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_CONFIG, enabled: false };
    }
    return { ...DEFAULT_CONFIG, ...(raw as Partial<ProactiveConfig>) };
}

export function loadConfig(): ProactiveConfig {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
        return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
    } catch (err) {
        Logger.warn(`proactive: config invalide — ${err}`);
        return { ...DEFAULT_CONFIG, enabled: false };
    }
}
