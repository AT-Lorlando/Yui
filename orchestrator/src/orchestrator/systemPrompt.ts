import * as fs from 'fs';
import * as path from 'path';
import Logger from '../logger';
import { loadManifest, resolveCoreFiles, resolveDomainFile } from './prompts';

export interface SystemPromptContext {
    alwaysMemory: string;
    onDemandNamespaces: string;
    storySummaries: string;
    /** Snapshot near-live de l'état des appareils, injecté à chaque ordre. */
    deviceState?: string;
    /** Active domain group names — used to load prompts/domains/<name>.md */
    activeGroups?: string[];
}

function formatDatetime(): string {
    const now = new Date();
    const days = [
        'dimanche',
        'lundi',
        'mardi',
        'mercredi',
        'jeudi',
        'vendredi',
        'samedi',
    ];
    const months = [
        'janvier',
        'février',
        'mars',
        'avril',
        'mai',
        'juin',
        'juillet',
        'août',
        'septembre',
        'octobre',
        'novembre',
        'décembre',
    ];
    const day = days[now.getDay()];
    const date = now.getDate();
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${day} ${date} ${month} ${year}, ${hours}h${minutes}`;
}

const PROMPTS_DIR = path.resolve(process.cwd(), 'prompts');

function readPromptFile(file: string): string {
    try {
        return fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8').trim();
    } catch (err) {
        Logger.warn(`Could not read prompt file "${file}": ${err}`);
        return '';
    }
}

/**
 * Enabled core prompts, in manifest order. These are always loaded regardless
 * of domain. The manifest (data/prompts.json) decides which files + ordering.
 */
function loadCoreDocs(): string {
    const files = resolveCoreFiles(loadManifest());
    const parts = files.map(readPromptFile).filter(Boolean);
    if (files.length > 0) Logger.debug(`Core prompts: ${files.join(', ')}`);
    return parts.join('\n\n---\n\n');
}

/**
 * Domain prompts for the active groups, resolved through the manifest (an
 * enabled domain entry whose `domain` matches the group name).
 */
function loadDomainDocs(activeGroups: string[]): string {
    if (activeGroups.length === 0) return '';
    const entries = loadManifest();
    const parts: string[] = [];
    const loaded: string[] = [];
    for (const group of activeGroups) {
        const file = resolveDomainFile(entries, group);
        if (!file) continue;
        const content = readPromptFile(file);
        if (content) {
            parts.push(content);
            loaded.push(group);
        }
    }
    if (loaded.length > 0) Logger.debug(`Domain prompts: ${loaded.join(', ')}`);
    return parts.join('\n\n---\n\n');
}

/**
 * Lit data/chromecast-content.json et renvoie une liste "titre → Plateforme"
 * pour les providers de streaming connus. Vide si fichier absent/illisible.
 */
function loadMediaCatalog(): string {
    const cacheFile = path.resolve(
        process.cwd(),
        'data',
        'chromecast-content.json',
    );
    if (!fs.existsSync(cacheFile)) return '';

    let cache: Record<string, Record<string, { title: string }>>;
    try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    } catch (err) {
        Logger.warn(`Could not parse chromecast-content.json: ${err}`);
        return '';
    }

    const display: Record<string, string> = {
        crunchyroll: 'Crunchyroll',
        netflix: 'Netflix',
        disney: 'Disney+',
        prime: 'Prime Video',
    };

    const lines: string[] = [];
    for (const [service, label] of Object.entries(display)) {
        const bucket = cache[service];
        if (!bucket) continue;
        for (const entry of Object.values(bucket)) {
            if (entry?.title) lines.push(`- ${entry.title} → ${label}`);
        }
    }
    return lines.join('\n');
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
    const coreDocs = loadCoreDocs();
    const domainDocs = loadDomainDocs(ctx.activeGroups ?? []);
    const datetime = formatDatetime();

    const sections: string[] = [];

    if (coreDocs) sections.push(coreDocs);
    if (domainDocs) sections.push(domainDocs);

    sections.push(`## Contexte actuel\n\nNous sommes le ${datetime}.`);

    if (ctx.alwaysMemory || ctx.onDemandNamespaces) {
        let mem = '## Mémoire';
        if (ctx.alwaysMemory) {
            mem += '\n\n### Données permanentes\n\n' + ctx.alwaysMemory;
        }
        if (ctx.onDemandNamespaces) {
            mem +=
                '\n\n### Données disponibles sur demande\n\n' +
                'Appelle `memory_read(namespace)` pour accéder à :\n' +
                ctx.onDemandNamespaces;
        }
        sections.push(mem);
    }

    if (ctx.deviceState) {
        sections.push(
            '## État actuel des appareils\n\n' +
                '(État récent, peut dater de quelques secondes — pour confirmer un état ' +
                "à Jérémy ou pour agir, utilise toujours l'outil correspondant.)\n\n" +
                ctx.deviceState,
        );
    }

    const mediaCatalog = loadMediaCatalog();
    if (mediaCatalog) {
        sections.push(
            '## Catalogue séries/films connus\n\n' +
                'Plateforme où regarder chaque titre. Pour lancer, appelle directement ' +
                'cast_<plateforme> (cast_crunchyroll, cast_netflix, cast_disney, cast_prime) avec le titre. ' +
                "Si un titre demandé n'est pas dans cette liste, appelle find_show pour trouver la plateforme.\n\n" +
                mediaCatalog,
        );
    }

    if (ctx.storySummaries) {
        sections.push(
            '## Discussions récentes\n\n' +
                ctx.storySummaries +
                '\n\nPour retrouver une discussion spécifique ("tu te souviens quand..."), appelle `search_stories(query)` avec une description en langage naturel.',
        );
    }

    return sections.join('\n\n---\n\n');
}
