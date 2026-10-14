// Migration v2 → v3 du courrier, une fois, au démarrage du moteur : les
// règles de mail-rules.json deviennent les listes d'expéditeurs
// (mail-senders.json), le rapport est posé dans mail-migration.json (revu
// dans l'app) et l'ancien fichier est renommé mail-rules.v2.bak.json.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../../logger';
import { migrateRulesToSenders, type MigrationReport } from './migrate';
import { RuleStore } from './rules';
import type { SenderStore } from './senders';

export const RULES_BACKUP_NAME = 'mail-rules.v2.bak.json';

/**
 * Migre si et seulement si les listes n'existent pas encore et que les
 * règles v2 existent. Rend le rapport, ou `null` si rien n'a été fait.
 * Ne lève jamais : un échec laisse mail-rules.json en place (nouvel essai au
 * prochain démarrage) et le courrier tourne sur des listes vides.
 */
export function migrateMailRulesAtBoot(
    senders: Pick<SenderStore, 'exists' | 'replace'>,
    now: number,
    rulesFile: string = dataPath('mail-rules.json'),
    reportFile: string = dataPath('mail-migration.json'),
): MigrationReport | null {
    if (senders.exists() || !fs.existsSync(rulesFile)) return null;
    try {
        const rules = new RuleStore(rulesFile).all();
        const { file, report } = migrateRulesToSenders(rules, now);
        senders.replace(file);
        fs.mkdirSync(path.dirname(reportFile), { recursive: true });
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        fs.renameSync(
            rulesFile,
            path.join(path.dirname(rulesFile), RULES_BACKUP_NAME),
        );
        Logger.info(
            `courrier : ${rules.length} règle(s) v2 migrée(s) — ${report.keep} à garder, ${report.spam} osef, ${report.dropped} abandonnée(s), ${report.unknown.length} à revoir`,
        );
        return report;
    } catch (err) {
        Logger.warn(`courrier : migration des règles v2 en échec — ${err}`);
        return null;
    }
}
