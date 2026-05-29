import * as fs from 'fs';

/**
 * Mémoire anti-répétition par sujet. Persistante si un chemin de fichier est
 * fourni (les cooldowns survivent alors à un redémarrage / pm2 reload),
 * purement en mémoire sinon (utilisé par les tests).
 */
export class Dedup {
    private last = new Map<string, number>();

    constructor(private file?: string) {
        this.load();
    }

    private load(): void {
        if (!this.file) return;
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
                if (raw && typeof raw === 'object') {
                    this.last = new Map(
                        Object.entries(raw as Record<string, number>),
                    );
                }
            }
        } catch {
            /* fichier corrompu — on repart vide */
        }
    }

    private save(): void {
        if (!this.file) return;
        try {
            fs.writeFileSync(
                this.file,
                JSON.stringify(Object.fromEntries(this.last)),
            );
        } catch {
            /* best-effort */
        }
    }

    isDuplicate(subject: string, now: number, cooldownMs: number): boolean {
        const prev = this.last.get(subject);
        return prev !== undefined && now - prev < cooldownMs;
    }

    record(subject: string, now: number): void {
        this.last.set(subject, now);
        this.save();
    }
}
