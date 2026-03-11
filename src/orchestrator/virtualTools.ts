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
    addSchedule,
    listSchedules,
    deleteSchedule,
    toggleSchedule,
} from './scheduler';
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
                name: 'schedule_add',
                description:
                    'Créer une tâche planifiée (cron job) — ex: rappels, automatisations récurrentes',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Nom lisible de la tâche',
                        },
                        cron: {
                            type: 'string',
                            description:
                                'Expression cron (ex: "30 8 * * 1-5" = lun-ven 8h30)',
                        },
                        prompt: {
                            type: 'string',
                            description:
                                'Ordre à envoyer à Yui quand le cron se déclenche',
                        },
                    },
                    required: ['name', 'cron', 'prompt'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'schedule_list',
                description: 'Lister toutes les tâches planifiées',
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'schedule_delete',
                description: 'Supprimer une tâche planifiée par son id',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                    },
                    required: ['id'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'schedule_toggle',
                description:
                    'Activer ou désactiver une tâche planifiée sans la supprimer',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                    },
                    required: ['id'],
                },
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
                    'Déclencher une scène par son nom ou son id. Recherche partielle insensible à la casse.',
                parameters: {
                    type: 'object',
                    properties: {
                        name_or_id: {
                            type: 'string',
                            description:
                                'Nom ou id de la scène (ex: "Forêt", "foret", "aurora")',
                        },
                    },
                    required: ['name_or_id'],
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
): Promise<ToolCallResult | null> {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || '{}');

    Logger.info(`Virtual tool: ${name}(${JSON.stringify(args)})`);

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

        case 'schedule_add': {
            const result = addSchedule(args.name, args.cron, args.prompt);
            if (typeof result === 'string')
                return { id: toolCall.id, content: result };
            return {
                id: toolCall.id,
                content: `Schedule "${args.name}" créé (id: ${result.id}, cron: ${result.cron})`,
            };
        }

        case 'schedule_list':
            return { id: toolCall.id, content: listSchedules() };

        case 'schedule_delete':
            return {
                id: toolCall.id,
                content: deleteSchedule(args.id)
                    ? `Schedule "${args.id}" supprimé.`
                    : `Schedule "${args.id}" introuvable.`,
            };

        case 'schedule_toggle':
            return { id: toolCall.id, content: toggleSchedule(args.id) };

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
            const query = String(args.name_or_id).toLowerCase();
            const scenes = listScenes();
            const scene =
                scenes.find((s) => s.id === query) ??
                scenes.find((s) => s.name.toLowerCase().includes(query)) ??
                scenes.find((s) => s.id.includes(query));
            if (!scene)
                return {
                    id: toolCall.id,
                    content: `Scène introuvable : "${
                        args.name_or_id
                    }". Scènes disponibles : ${scenes
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
