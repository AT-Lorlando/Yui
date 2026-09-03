import OpenAI from 'openai';
import Logger from '../logger';
import { getSettings } from '../settings';
import env from '../env';

/**
 * Routage LLM — choisir le modèle par requête.
 *
 * Trois profils : `custom` (le modèle des réglages — le llama-server local),
 * `deepseek` et `claude` (presets cloud, clé dans le .env). Le réglage
 * `llm.profile` force un profil, ou vaut `auto` : les ordres simples
 * (« éteins le salon ») restent sur le local, les ordres complexes
 * (planification, rédaction, raisonnement) partent sur `llm.smartProfile`.
 *
 * Tout est OpenAI-compatible (l'API Anthropic expose /v1/chat/completions) :
 * un seul SDK, des clients mis en cache par (baseURL, clé).
 */

interface Preset {
    baseURL: string;
    model: string;
    keyEnv: string;
}

const PRESETS: Record<string, Preset> = {
    deepseek: {
        baseURL: 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        keyEnv: 'DEEPSEEK_API_KEY',
    },
    claude: {
        baseURL: 'https://api.anthropic.com/v1/',
        model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-5',
        keyEnv: 'ANTHROPIC_API_KEY',
    },
};

export interface LlmChoice {
    client: OpenAI;
    model: string;
    profile: string;
}

/**
 * Heuristique de complexité — pur, testé. Un ordre est « complexe » s'il est
 * long, multi-étapes, ou demande du raisonnement/de la rédaction plutôt
 * qu'une commande domotique directe.
 */
const SMART_KEYWORDS =
    /\b(planifie|organise|compare|analyse|résume|resume|explique|pourquoi|rédige|redige|écris|ecris|propose|réfléchis|reflechis|prépare|recherche|idée|idees|conseil|stratégie|strategie|calcule|traduis)\b/i;

export function isComplexOrder(order: string): boolean {
    if (order.length > 180) return true;
    if (SMART_KEYWORDS.test(order)) return true;
    // Multi-étapes explicites : « fais A, puis B, ensuite C »
    const steps = (order.match(/\b(puis|ensuite|après ça|apres ca)\b/gi) ?? [])
        .length;
    return steps >= 2;
}

const clientCache = new Map<string, OpenAI>();

function clientFor(baseURL: string | undefined, apiKey: string): OpenAI {
    const key = `${baseURL ?? 'default'}|${apiKey.slice(0, 8)}`;
    let c = clientCache.get(key);
    if (!c) {
        c = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
        clientCache.set(key, c);
    }
    return c;
}

function customChoice(): LlmChoice {
    const llm = getSettings().llm;
    return {
        client: clientFor(llm.baseUrl ?? env.LLM_BASE_URL, env.LLM_API_KEY),
        model: llm.model || env.LLM_MODEL,
        profile: 'custom',
    };
}

function presetChoice(name: string): LlmChoice | null {
    const preset = PRESETS[name];
    if (!preset) return null;
    const apiKey = process.env[preset.keyEnv];
    if (!apiKey) {
        Logger.warn(
            `[llm] profil "${name}" demandé mais ${preset.keyEnv} absente du .env — repli sur le modèle local`,
        );
        return null;
    }
    return {
        client: clientFor(preset.baseURL, apiKey),
        model: preset.model,
        profile: name,
    };
}

/**
 * Choisit le LLM pour un ordre donné, selon `llm.profile` des réglages :
 * `custom` (défaut), `deepseek`, `claude`, ou `auto` (complexité).
 */
export function resolveLlm(order?: string): LlmChoice {
    const settings = getSettings().llm as {
        profile?: string;
        smartProfile?: string;
    } & ReturnType<typeof getSettings>['llm'];
    const profile = settings.profile ?? 'custom';

    if (profile === 'auto') {
        if (order && isComplexOrder(order)) {
            const smart = presetChoice(settings.smartProfile ?? 'claude');
            if (smart) {
                Logger.info(
                    `[llm] ordre complexe → profil "${smart.profile}" (${smart.model})`,
                );
                return smart;
            }
        }
        return customChoice();
    }
    if (profile !== 'custom') {
        const choice = presetChoice(profile);
        if (choice) return choice;
    }
    return customChoice();
}
