export interface LightSetDeps {
    getRoomNames: () => string[];
    setRoomLights: (
        room: string,
        opts: {
            on?: boolean;
            brightness?: number;
            color?: string;
            transitionMs?: number;
        },
    ) => Promise<unknown>;
    setRoomPalette: (
        room: string,
        colors: string[],
        brightness?: number,
    ) => Promise<unknown>;
    findLightByName: (name: string) => { id: number; name: string } | undefined;
    setLight: (
        id: number,
        opts: { on?: boolean; brightness?: number; color?: string },
    ) => Promise<unknown>;
}

const DYN = ['time_brightness', 'random'];

export function buildLightSetTools(
    roomNames: string[],
    lightNames: string[] = [],
) {
    const targets = ['all', ...roomNames, ...lightNames];
    return [
        {
            name: 'light_set',
            description:
                "Allume/éteint une lampe, une pièce ou tout, avec luminosité et couleur. Caché du LLM — pour l'éditeur.",
            inputSchema: {
                type: 'object' as const,
                properties: {
                    target: {
                        type: 'string',
                        enum: targets,
                        description: 'Cible : "all", une pièce, ou une lampe.',
                    },
                    on: {
                        type: 'boolean',
                        description: 'Allumer (défaut) ou éteindre.',
                    },
                    brightness: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        'x-dynamic': DYN,
                        description: 'Luminosité 0–100.',
                    },
                    color: {
                        type: 'string',
                        'x-widget': 'color',
                        description: 'Couleur hex.',
                    },
                },
                required: ['target'],
            },
        },
        {
            name: 'lights_palette_set',
            description:
                "Applique un dégradé de couleurs à une pièce ou à tout. Caché du LLM — pour l'éditeur.",
            inputSchema: {
                type: 'object' as const,
                properties: {
                    target: {
                        type: 'string',
                        enum: ['all', ...roomNames],
                        description: 'Cible : "all" ou une pièce.',
                    },
                    colors: {
                        type: 'array',
                        items: { type: 'string', 'x-widget': 'color' },
                        minItems: 1,
                        description: 'Couleurs hex.',
                    },
                    brightness: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        'x-dynamic': DYN,
                        description: 'Luminosité 0–100.',
                    },
                },
                required: ['target', 'colors'],
            },
        },
    ];
}

function lightOpts(args: Record<string, unknown>) {
    const opts: { on?: boolean; brightness?: number; color?: string } = {
        on: args.on === undefined ? true : Boolean(args.on),
    };
    if (args.brightness !== undefined)
        opts.brightness = Number(args.brightness);
    if (args.color !== undefined) opts.color = String(args.color);
    return opts;
}

export async function handleLightSet(
    args: Record<string, unknown>,
    deps: LightSetDeps,
): Promise<string> {
    const target = String(args.target);
    const opts = lightOpts(args);
    if (target === 'all') {
        for (const room of deps.getRoomNames())
            await deps.setRoomLights(room, opts);
        return 'Toutes les lampes mises à jour.';
    }
    const light = deps.findLightByName(target);
    if (light) {
        await deps.setLight(light.id, opts);
        return `${light.name} mise à jour.`;
    }
    await deps.setRoomLights(target, opts);
    return `${target} mis à jour.`;
}

export async function handleLightsPaletteSet(
    args: Record<string, unknown>,
    deps: LightSetDeps,
): Promise<string> {
    const target = String(args.target);
    const colors = (args.colors as string[]) ?? [];
    const brightness =
        args.brightness !== undefined ? Number(args.brightness) : undefined;
    const rooms = target === 'all' ? deps.getRoomNames() : [target];
    for (const room of rooms)
        await deps.setRoomPalette(room, colors, brightness);
    return `Palette appliquée (${rooms.join(', ')}).`;
}
