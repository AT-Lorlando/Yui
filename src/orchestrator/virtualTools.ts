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

export interface ToolCallResult {
    id: string;
    content: string;
}

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
    ];
}

/**
 * Handles virtual (in-process) tool calls.
 * Returns null if the tool name is not virtual — caller should route to MCP.
 */
export async function handleVirtualTool(
    toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
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

        default:
            return null;
    }
}
