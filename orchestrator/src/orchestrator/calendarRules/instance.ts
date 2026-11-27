// Identifiant de cette instance de Yui. Dev et prod sont deux checkouts sur le
// même compte Google : chaque événement de règle porte `yuiInstance`, et la
// sync ne touche qu'aux siens. `YUI_INSTANCE` s'il est posé, sinon un id tiré
// une fois et persisté dans data/state/instance-id.json.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

/** Lève si le fichier existe mais est illisible : un nouvel id rendrait
 *  orphelins tous les événements déjà posés (doublons à chaque run). */
export function instanceId(): string {
    const env = process.env.YUI_INSTANCE?.trim();
    if (env) return env;

    const f = dataPath('instance-id.json');
    if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { id?: unknown };
        if (typeof raw?.id !== 'string' || !raw.id.trim())
            throw new Error(`${f} : id d'instance absent`);
        return raw.id.trim();
    }
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id }, null, 2));
    fs.renameSync(tmp, f);
    return id;
}
