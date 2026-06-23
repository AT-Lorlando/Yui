export interface Caster {
    netflix: (title?: string) => Promise<string>;
    youtube: (src?: string) => Promise<string>;
    crunchyroll: (title?: string) => Promise<string>;
    disney: (title?: string) => Promise<string>;
    prime: (title?: string) => Promise<string>;
}

const APPS = ['netflix', 'youtube', 'crunchyroll', 'disney', 'prime'] as const;

export const CAST_APP_TOOL = {
    name: 'cast_app',
    description: 'Lance une app de streaming sur la TV (avec titre optionnel).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            app: {
                type: 'string',
                enum: [...APPS],
                description: 'Application de streaming.',
            },
            title: {
                type: 'string',
                description: 'Titre à rechercher (optionnel).',
            },
        },
        required: ['app'],
    },
};

export async function handleCastApp(
    args: Record<string, unknown>,
    caster: Caster,
): Promise<string> {
    const app = String(args.app) as keyof Caster;
    const title = args.title !== undefined ? String(args.title) : undefined;
    if (!APPS.includes(app as any)) throw new Error(`App inconnue : ${app}`);
    return caster[app](title);
}
