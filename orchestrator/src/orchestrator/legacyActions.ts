/**
 * Migration des noms d'actions legacy vers leurs équivalents canoniques.
 *
 * `light_set`, `lights_palette_set`, `music_play` et `covers_set` étaient des
 * alias à schéma enrichi de tools existants ; ils ont été supprimés des
 * serveurs MCP quand les tools canoniques ont gagné leurs propres enums. Mais
 * la config n'est pas versionnée (prod = checkout séparé, source de vérité) :
 * des scènes et bindings enregistrés avec les anciens noms existent encore.
 *
 * Ce shim traduit à la lecture — les fichiers sur disque ne sont pas
 * réécrits, prod continue de marcher tel quel. Appliqué par loadScenes() et
 * par le chargement des bindings hue-remotes.
 */

interface ActionLike {
    tool: string;
    args?: Record<string, unknown>;
}

function migrateOne(a: ActionLike): ActionLike {
    const args = a.args ?? {};
    switch (a.tool) {
        case 'light_set': {
            const target = String(args.target ?? '');
            if (target === 'all') {
                // set_lights ne connaît pas 'all' — router vers les tools globaux.
                return args.on === false
                    ? { ...a, tool: 'turn_off_all_lights', args: {} }
                    : {
                          ...a,
                          tool: 'turn_on_all_lights',
                          args:
                              args.brightness !== undefined
                                  ? { brightness: args.brightness }
                                  : {},
                      };
            }
            return { ...a, tool: 'set_lights' };
        }
        case 'lights_palette_set': {
            const { target, ...rest } = args;
            if (String(target ?? '') === 'all') {
                return { ...a, tool: '_lights_palette', args: rest };
            }
            return {
                ...a,
                tool: 'set_room_palette',
                args: { room: target, ...rest },
            };
        }
        case 'music_play': {
            const { speaker, ...rest } = args;
            return {
                ...a,
                tool: 'play_music',
                args: {
                    ...rest,
                    ...(speaker !== undefined ? { speakerName: speaker } : {}),
                },
            };
        }
        case 'covers_set': {
            // Pas de forme 'all' côté canonique — aucun usage constaté, on
            // traduit le cas nominal et on laisse 'all' échouer explicitement.
            if (String(args.target ?? '') !== 'all') {
                const { target, ...rest } = args;
                return {
                    ...a,
                    tool: 'set_cover_position',
                    args: { device: target, ...rest },
                };
            }
            return a;
        }
        default:
            return a;
    }
}

/** Migre une liste d'actions, y compris les branches d'un bloc `_if`. */
export function migrateLegacyActions<T extends ActionLike>(
    actions: T[] | undefined,
): T[] {
    if (!Array.isArray(actions)) return [];
    return actions.map((a) => {
        const m = migrateOne(a) as T;
        if (m.tool === '_if' && m.args) {
            const args = m.args as Record<string, unknown>;
            return {
                ...m,
                args: {
                    ...args,
                    then: migrateLegacyActions(
                        args.then as ActionLike[] | undefined,
                    ),
                    else: migrateLegacyActions(
                        args.else as ActionLike[] | undefined,
                    ),
                },
            };
        }
        return m;
    });
}
