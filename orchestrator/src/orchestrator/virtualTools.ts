import OpenAI from 'openai';
import Logger from '../logger';
import {
    saveMemory,
    deleteMemory,
    readNamespace,
    listNamespaces,
} from './memory';
import { searchStoriesWithLLM } from './storyArchive';
import {
    addAutomation,
    loadAutomations,
    deleteAutomation,
    toggleAutomation,
    type OutputChannel,
} from './automations';
import { listScenes } from './scenes';

export interface ToolCallResult {
    id: string;
    content: string;
}

/** Runs a scene by id. Returns success/error. */
export type SceneRunner = (
    id: string,
) => Promise<{ success: boolean; error?: string }>;

export function getVirtualTools(): OpenAI.Chat.ChatCompletionTool[] {
    return [
        {
            type: 'function',
            function: {
                name: 'memory_save',
                description:
                    'Sauvegarder un fait en mémoire persistante (par namespace/catégorie)',
                parameters: {
                    type: 'object',
                    properties: {
                        namespace: {
                            type: 'string',
                            description:
                                'Catégorie (ex: personnel, musique, recettes, notes)',
                        },
                        key: {
                            type: 'string',
                            description: 'Nom/clé du fait',
                        },
                        value: {
                            type: 'string',
                            description: 'Valeur à retenir',
                        },
                        priority: {
                            type: 'string',
                            enum: ['always', 'on-demand'],
                            description:
                                'always = injecté dans chaque prompt (petit et fréquent), on-demand = disponible sur demande (volumineux ou rare)',
                        },
                    },
                    required: ['namespace', 'key', 'value'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memory_delete',
                description: 'Supprimer un fait de la mémoire',
                parameters: {
                    type: 'object',
                    properties: {
                        namespace: { type: 'string' },
                        key: { type: 'string' },
                    },
                    required: ['namespace', 'key'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memory_read',
                description:
                    "Lire le contenu d'un namespace mémoire (pour les namespaces on-demand)",
                parameters: {
                    type: 'object',
                    properties: {
                        namespace: { type: 'string' },
                    },
                    required: ['namespace'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memory_list',
                description:
                    'Lister tous les namespaces mémoire disponibles avec leur taille',
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'search_stories',
                description:
                    'Recherche sémantique dans les discussions passées. Utilise cet outil quand Jérémy fait référence à une conversation précédente ("tu te souviens quand...", "la dernière fois qu\'on a parlé de..."). Retourne le transcript complet des discussions les plus pertinentes.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description:
                                'Description en langage naturel de ce que tu cherches (ex: "quand j\'ai demandé d\'envoyer un email", "la discussion sur la météo d\'hier")',
                        },
                    },
                    required: ['query'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'automation_add',
                description:
                    'Créer une automation — scène directe ou prompt LLM, déclenchée par cron (récurrent) ou délai (one-shot)',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Nom lisible',
                        },
                        trigger_type: {
                            type: 'string',
                            enum: ['cron', 'delay'],
                            description:
                                'cron = récurrent (ex: "0 8 * * 1-5"), delay = one-shot dans X minutes',
                        },
                        cron_expr: {
                            type: 'string',
                            description:
                                'Expression cron (requis si trigger_type = cron). Ex: "30 8 * * 1-5" = lun-ven 8h30',
                        },
                        delay_minutes: {
                            type: 'number',
                            description:
                                'Délai en minutes (requis si trigger_type = delay). Ex: 20 = dans 20 minutes',
                        },
                        action_type: {
                            type: 'string',
                            enum: ['scene', 'prompt'],
                            description:
                                'scene = déclenche une scène directement (sans LLM), prompt = envoie un ordre au LLM',
                        },
                        scene_id: {
                            type: 'string',
                            description:
                                'Id de la scène (requis si action_type = scene)',
                        },
                        prompt_text: {
                            type: 'string',
                            description:
                                'Ordre à envoyer à Yui (requis si action_type = prompt)',
                        },
                        prompt_output: {
                            type: 'string',
                            enum: ['cast', 'notify', 'none'],
                            description:
                                'Canal de sortie pour la réponse LLM (défaut: cast)',
                        },
                        notify: {
                            type: 'string',
                            description:
                                'Message TTS dit par Yui après exécution (uniquement pour action_type = scene). Absent = silence.',
                        },
                    },
                    required: ['name', 'trigger_type', 'action_type'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'automation_list',
                description: 'Lister toutes les automations',
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'automation_delete',
                description: 'Supprimer une automation par son id',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'automation_toggle',
                description:
                    'Activer ou désactiver une automation sans la supprimer',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'house_off',
                description:
                    "Éteint TOUT en une seule commande : toutes les lumières (Hue + Govee), la TV, le Chromecast, la musique Spotify, et l'ampli Marantz. " +
                    'À utiliser quand Jérémy dit "éteins tout", "tout off", "j\'éteins" sans précision. ' +
                    "Idempotent — sûr d'appeler même si certains appareils sont déjà éteints.",
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'scene_list',
                description:
                    'Lister toutes les scènes disponibles (intégrées et personnalisées)',
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'scene_trigger',
                description:
                    'Déclencher une scène (ambiance pré-définie combinant lumières, musique, etc.) par son nom ou son id. ' +
                    "IMPORTANT : n'utilise scene_trigger QUE pour des ambiances génériques explicitement nommées par l'utilisateur " +
                    '(ex: "lance la scène cinéma", "ambiance forêt"). ' +
                    'Pour lancer un film/anime/série spécifique (ex: "lance Re:Zero", "lance Breaking Bad"), ' +
                    'utilise toujours les tools cast_netflix/cast_crunchyroll/cast_disney/cast_prime ' +
                    'en passant le titre dans `title`, JAMAIS scene_trigger.',
                parameters: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description:
                                'Id ou nom d\'une scène existante (vue via scene_list). La résolution essaie d\'abord l\'id exact, puis le nom. Ex: "lofi", "Forêt", "cinéma"',
                        },
                    },
                    required: ['id'],
                },
            },
        },
    ];
}

/**
 * Handles virtual (in-process) tool calls.
 * Returns null if the tool name is not virtual — caller should route to MCP.
 */
export async function handleVirtualTool(
    toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
    sceneRunner?: SceneRunner,
    outputChannel: OutputChannel = 'cast',
    callTool?: (
        name: string,
        args: Record<string, unknown>,
    ) => Promise<unknown>,
): Promise<ToolCallResult | null> {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || '{}');

    Logger.debug(`Virtual tool: ${name}(${JSON.stringify(args)})`);

    switch (name) {
        case 'memory_save':
            saveMemory(args.namespace, args.key, args.value, args.priority);
            return {
                id: toolCall.id,
                content: `Mémorisé : [${args.namespace}] ${args.key} = ${args.value}`,
            };

        case 'memory_delete':
            deleteMemory(args.namespace, args.key);
            return {
                id: toolCall.id,
                content: `Oublié : [${args.namespace}] ${args.key}`,
            };

        case 'memory_read':
            return { id: toolCall.id, content: readNamespace(args.namespace) };

        case 'memory_list':
            return { id: toolCall.id, content: listNamespaces() };

        case 'search_stories':
            return {
                id: toolCall.id,
                content: await searchStoriesWithLLM(args.query as string),
            };

        case 'automation_add': {
            const triggerType = args.trigger_type as 'cron' | 'delay';
            const actionType = args.action_type as 'scene' | 'prompt';

            let trigger: import('./automations').AutomationTrigger;
            if (triggerType === 'cron') {
                if (!args.cron_expr)
                    return {
                        id: toolCall.id,
                        content: 'cron_expr requis pour trigger_type=cron.',
                    };
                trigger = { type: 'cron', expr: args.cron_expr as string };
            } else {
                const minutes = Number(args.delay_minutes);
                if (!minutes || minutes <= 0)
                    return {
                        id: toolCall.id,
                        content:
                            'delay_minutes requis pour trigger_type=delay.',
                    };
                trigger = {
                    type: 'delay',
                    ms: minutes * 60_000,
                    fireAt: Date.now() + minutes * 60_000,
                };
            }

            let action: import('./automations').AutomationAction;
            if (actionType === 'scene') {
                if (!args.scene_id)
                    return {
                        id: toolCall.id,
                        content: 'scene_id requis pour action_type=scene.',
                    };
                action = { type: 'scene', sceneId: args.scene_id as string };
            } else {
                if (!args.prompt_text)
                    return {
                        id: toolCall.id,
                        content: 'prompt_text requis pour action_type=prompt.',
                    };
                action = {
                    type: 'prompt',
                    text: args.prompt_text as string,
                    ...(args.prompt_output
                        ? { output: args.prompt_output as OutputChannel }
                        : {}),
                };
            }

            const automation = addAutomation({
                name: args.name as string,
                trigger,
                action,
                notify: (args.notify as string | undefined) ?? null,
                enabled: true,
            });
            return {
                id: toolCall.id,
                content: `Automation "${automation.name}" créée (id: ${
                    automation.id
                }, trigger: ${
                    automation.trigger.type === 'cron'
                        ? `cron ${automation.trigger.expr}`
                        : `dans ${Math.round(
                              automation.trigger.ms / 60_000,
                          )} min`
                })`,
            };
        }

        case 'automation_list': {
            const automations = loadAutomations();
            if (automations.length === 0)
                return {
                    id: toolCall.id,
                    content: '(aucune automation enregistrée)',
                };
            const lines = automations.map((a) => {
                const trig =
                    a.trigger.type === 'cron'
                        ? `cron: ${a.trigger.expr}`
                        : `dans ${Math.round(
                              (a.trigger.fireAt - Date.now()) / 60_000,
                          )} min`;
                const act =
                    a.action.type === 'scene'
                        ? `scène: ${a.action.sceneId}`
                        : `prompt: "${a.action.text.slice(0, 40)}..."`;
                return `[${a.id}] "${a.name}" — ${trig} — ${act} — ${
                    a.enabled ? '✓' : '✗'
                }`;
            });
            return { id: toolCall.id, content: lines.join('\n') };
        }

        case 'automation_delete':
            return {
                id: toolCall.id,
                content: deleteAutomation(args.id as string)
                    ? `Automation "${args.id}" supprimée.`
                    : `Automation "${args.id}" introuvable.`,
            };

        case 'automation_toggle': {
            const msg = toggleAutomation(args.id as string);
            return {
                id: toolCall.id,
                content: msg ?? `Automation "${args.id}" introuvable.`,
            };
        }

        case 'house_off': {
            if (!callTool) {
                return {
                    id: toolCall.id,
                    content: 'Erreur: callTool indisponible.',
                };
            }
            const results = await Promise.allSettled([
                callTool('turn_off_all_lights', {}),
                callTool('tv_off', {}),
                callTool('cast_stop', {}),
                callTool('stop_music', {}),
                callTool('amp_off', {}),
            ]);
            const failures = results
                .map((r, i) => ({
                    r,
                    name: ['lights', 'tv', 'cast', 'music', 'amp'][i],
                }))
                .filter((x) => x.r.status === 'rejected')
                .map((x) => x.name);
            return {
                id: toolCall.id,
                content: failures.length
                    ? `Tout éteint (échecs partiels: ${failures.join(', ')}).`
                    : 'Tout éteint.',
            };
        }

        case 'scene_list': {
            const scenes = listScenes();
            if (scenes.length === 0)
                return { id: toolCall.id, content: 'Aucune scène disponible.' };
            const lines = scenes.map(
                (s) =>
                    `- ${s.name} (id: ${s.id})${
                        s.builtIn ? ' [intégrée]' : ''
                    }: ${s.description}`,
            );
            return {
                id: toolCall.id,
                content: `${
                    scenes.length
                } scène(s) disponible(s) :\n${lines.join('\n')}`,
            };
        }

        case 'scene_trigger': {
            if (!sceneRunner)
                return {
                    id: toolCall.id,
                    content: 'Erreur: scene runner non disponible.',
                };
            // Accept `id` (canonical), `name` (display name), or legacy `name_or_id`.
            const raw = String(args.id ?? args.name ?? args.name_or_id ?? '');
            const query = raw.toLowerCase();
            const scenes = listScenes();
            const scene =
                scenes.find((s) => s.id === query) ??
                scenes.find((s) => s.name.toLowerCase() === query) ??
                scenes.find((s) => s.name.toLowerCase().includes(query)) ??
                scenes.find((s) => s.id.includes(query));
            if (!scene)
                return {
                    id: toolCall.id,
                    content: `Scène introuvable : "${raw}". Scènes disponibles : ${scenes
                        .map((s) => s.name)
                        .join(', ')}`,
                };
            Logger.info(`Triggering scene "${scene.name}" (${scene.id})`);
            const result = await sceneRunner(scene.id);
            return {
                id: toolCall.id,
                content: result.success
                    ? `Scène "${scene.name}" déclenchée.`
                    : `Erreur lors du déclenchement de "${scene.name}": ${result.error}`,
            };
        }

        default:
            return null;
    }
}
