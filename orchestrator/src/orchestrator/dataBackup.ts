import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from '@yui/shared';
import Logger from '../logger';
import { logActivity } from './activityLog';

/**
 * Sauvegarde de `data/` — l'assurance-vie de la config d'instance.
 *
 * `data/config` (scènes, automations, télécommandes, effets…) et
 * `data/shared` (credentials) sont hors git, sur un seul disque, construits à
 * la main pendant des semaines. Ce module en fait une archive tar.gz
 * quotidienne, plus la mémoire de Yui (`state/memory.json`).
 *
 * - Destination : `YUI_BACKUP_DIR` (idéalement un AUTRE disque, ex.
 *   /share/yui_backup) — défaut `<dataRoot>/backups` (mieux que rien).
 * - Rotation : `BACKUP_KEEP` archives (défaut 14).
 * - Déclenchement : au boot si la dernière archive a plus de 20 h, puis
 *   toutes les heures on revérifie (donc ~1/jour, sans cron système).
 * - Best-effort : un échec logge et notifie le journal, ne casse rien.
 */

const KEEP = Number(process.env.BACKUP_KEEP ?? 14);
const STALE_MS = 20 * 60 * 60_000;
const CHECK_MS = 60 * 60_000;

/** Contenu sauvegardé, relatif à dataRoot. Les chemins absents sont ignorés. */
const INCLUDE = ['config', 'shared', 'state/memory.json'];

function backupDir(): string {
    return process.env.YUI_BACKUP_DIR ?? path.join(dataRoot(), 'backups');
}

const NAME_RE = /^yui-data-(\d{4}-\d{2}-\d{2})(?:[T_-]?[\d-]*)?\.tar\.gz$/;

/** Archives triées de la plus récente à la plus ancienne. Pur (testé). */
export function sortBackups(names: string[]): string[] {
    return names
        .filter((n) => NAME_RE.test(n))
        .sort((a, b) => b.localeCompare(a));
}

/** Celles à supprimer pour n'en garder que `keep`. Pur (testé). */
export function backupsToPrune(names: string[], keep: number): string[] {
    return sortBackups(names).slice(Math.max(0, keep));
}

function lastBackupAgeMs(dir: string): number | null {
    try {
        const newest = sortBackups(fs.readdirSync(dir))[0];
        if (!newest) return null;
        return Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs;
    } catch {
        return null;
    }
}

function tar(outFile: string, cwd: string, entries: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            'tar',
            ['-czf', outFile, '-C', cwd, ...entries],
            { timeout: 120_000 },
            (error, _stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr?.trim() || error.message));
                } else {
                    resolve();
                }
            },
        );
    });
}

/** Crée une archive maintenant. Renvoie son chemin, ou null si échec. */
export async function runBackup(): Promise<string | null> {
    const root = dataRoot();
    const dir = backupDir();
    const entries = INCLUDE.filter((e) => fs.existsSync(path.join(root, e)));
    if (!entries.length) {
        Logger.warn('[backup] rien à sauvegarder (data/ vide ?)');
        return null;
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const out = path.join(dir, `yui-data-${stamp}.tar.gz`);
        await tar(out, root, entries);
        const sizeKb = Math.round(fs.statSync(out).size / 1024);
        Logger.info(`[backup] ${out} (${sizeKb} Ko)`);
        logActivity('automation', 'Sauvegarde data/', `${sizeKb} Ko`);

        for (const name of backupsToPrune(fs.readdirSync(dir), KEEP)) {
            fs.unlinkSync(path.join(dir, name));
        }
        return out;
    } catch (e) {
        Logger.error(`[backup] échec : ${e}`);
        logActivity('automation', 'Sauvegarde data/ ÉCHOUÉE', String(e));
        return null;
    }
}

let timer: NodeJS.Timeout | undefined;

/** Démarre la sauvegarde périodique (boot de l'orchestrateur). */
export function startBackupSchedule(): void {
    const tick = () => {
        const age = lastBackupAgeMs(backupDir());
        if (age === null || age > STALE_MS) void runBackup();
    };
    tick();
    timer = setInterval(tick, CHECK_MS);
    timer.unref?.();
}

export function stopBackupSchedule(): void {
    if (timer) clearInterval(timer);
}
