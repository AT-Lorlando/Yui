import * as fs from 'fs';

interface Entry {
    at: number;
    message: string;
}

/**
 * Mémoire anti-répétition par sujet. Stocke, pour chaque sujet, la date de la
 * dernière émission (`at`) et le dernier message communiqué (`message`).
 * Persistante si un chemin de fichier est fourni (les cooldowns survivent alors à
 * un redémarrage / pm2 reload), purement en mémoire sinon (utilisé par les tests).
 */
export class Dedup {
    private last = new Map<string, Entry>();

    constructor(private file?: string) {
        this.load();
    }

    private load(): void {
        if (!this.file) return;
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
                if (raw && typeof raw === 'object') {
                    for (const [subject, val] of Object.entries(raw)) {
                        if (typeof val === 'number') {
                            // ancien format plat { subject: ts }
                            this.last.set(subject, { at: val, message: '' });
                        } else if (
                            val &&
                            typeof val === 'object' &&
                            typeof (val as Entry).at === 'number'
                        ) {
                            const e = val as Entry;
                            this.last.set(subject, {
                                at: e.at,
                                message:
                                    typeof e.message === 'string'
                                        ? e.message
                                        : '',
                            });
                        }
                    }
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
        return prev !== undefined && now - prev.at < cooldownMs;
    }

    /** Dernier message communiqué pour ce sujet, ou undefined si jamais vu. */
    lastMessage(subject: string): string | undefined {
        return this.last.get(subject)?.message;
    }

    /**
     * Enregistre une émission. Avec `message`, mémorise ce qui a été dit. Sans
     * `message` (cas « ré-arme » après un RIEN), met à jour `at` et conserve le
     * message précédent.
     */
    record(subject: string, now: number, message?: string): void {
        const prev = this.last.get(subject);
        this.last.set(subject, {
            at: now,
            message: message ?? prev?.message ?? '',
        });
        this.save();
    }
}
