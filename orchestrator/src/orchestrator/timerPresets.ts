import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

const PRESETS_FILE = dataPath('timer-presets.json');

export interface TimerPreset {
    id: string;
    label: string;
    duration_seconds: number;
    icon?: string;
}

function ensureDataDir(): void {
    const dir = path.dirname(PRESETS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function listPresets(): TimerPreset[] {
    try {
        if (!fs.existsSync(PRESETS_FILE)) return [];
        return JSON.parse(
            fs.readFileSync(PRESETS_FILE, 'utf-8'),
        ) as TimerPreset[];
    } catch {
        return [];
    }
}

function save(presets: TimerPreset[]): void {
    ensureDataDir();
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
}

export function addPreset(input: {
    label: string;
    duration_seconds: number;
    icon?: string;
}): TimerPreset {
    if (typeof input.label !== 'string' || !input.label.trim()) {
        throw new Error('label is required');
    }
    if (
        !Number.isInteger(input.duration_seconds) ||
        input.duration_seconds <= 0
    ) {
        throw new Error('duration_seconds must be a positive integer');
    }
    const preset: TimerPreset = {
        id: `tp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: input.label.trim(),
        duration_seconds: input.duration_seconds,
        ...(input.icon ? { icon: input.icon } : {}),
    };
    const presets = listPresets();
    presets.push(preset);
    save(presets);
    return preset;
}

export function removePreset(id: string): boolean {
    const presets = listPresets();
    const next = presets.filter((p) => p.id !== id);
    if (next.length === presets.length) return false;
    save(next);
    return true;
}
