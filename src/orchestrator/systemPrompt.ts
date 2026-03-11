import * as fs from 'fs';
import * as path from 'path';
import Logger from '../logger';

export interface SystemPromptContext {
    alwaysMemory: string;
    onDemandNamespaces: string;
    storySummaries: string;
    /** Compact entity summary fetched at startup (lights, doors, speakers). */
    entities?: string;
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

/**
 * Reads all .md files from prompts/ root (alphabetical order).
 * These are always loaded regardless of domain.
 */
function loadCoreDocs(): string {
    const promptsDir = path.resolve(process.cwd(), 'prompts');
    if (!fs.existsSync(promptsDir)) {
        Logger.warn('prompts/ directory not found — using empty base prompt');
        return '';
    }

    const files = fs
        .readdirSync(promptsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

    const parts: string[] = [];
    for (const file of files) {
        try {
            const content = fs
                .readFileSync(path.join(promptsDir, file), 'utf-8')
                .trim();
            if (content) parts.push(content);
        } catch (err) {
            Logger.warn(`Could not read prompt file "${file}": ${err}`);
        }
    }

    if (files.length > 0) Logger.debug(`Core prompts: ${files.join(', ')}`);
    return parts.join('\n\n---\n\n');
}

/**
 * Reads domain-specific .md files from prompts/domains/ for the active groups.
 */
function loadDomainDocs(activeGroups: string[]): string {
    if (activeGroups.length === 0) return '';
    const domainsDir = path.resolve(process.cwd(), 'prompts', 'domains');
    if (!fs.existsSync(domainsDir)) return '';

    const parts: string[] = [];
    for (const group of activeGroups) {
        const filePath = path.join(domainsDir, `${group}.md`);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8').trim();
                if (content) parts.push(content);
            }
        } catch (err) {
            Logger.warn(`Could not read domain prompt "${group}.md": ${err}`);
        }
    }

    if (parts.length > 0)
        Logger.debug(`Domain prompts: ${activeGroups.join(', ')}`);
    return parts.join('\n\n---\n\n');
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

    if (ctx.entities) {
        sections.push(`## Appareils connus\n\n${ctx.entities}`);
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
