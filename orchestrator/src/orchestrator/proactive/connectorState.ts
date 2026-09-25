// Mémoire persistante d'un connecteur (dernier poll, ids déjà vus…) —
// data/state/connectors/<id>.json, écriture synchrone best-effort.
import * as fs from 'fs';
import * as path from 'path';
import { stateDir } from '@yui/shared';

export function connectorStateFile(id: string): string {
    return path.join(
        stateDir('connectors'),
        `${id.replace(/[^a-z0-9:_-]/gi, '_')}.json`,
    );
}

export class ConnectorState {
    private data: Record<string, unknown> = {};

    constructor(private file?: string) {
        if (!file) return;
        try {
            if (fs.existsSync(file)) {
                const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (raw && typeof raw === 'object' && !Array.isArray(raw))
                    this.data = raw;
            }
        } catch {
            /* corrompu → vide */
        }
    }

    get<T>(key: string, fallback: T): T {
        return (this.data[key] === undefined ? fallback : this.data[key]) as T;
    }

    set(key: string, value: unknown): void {
        this.data[key] = value;
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.data));
        } catch {
            /* best-effort */
        }
    }
}
