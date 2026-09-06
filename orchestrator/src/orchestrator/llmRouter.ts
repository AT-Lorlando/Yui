import OpenAI from 'openai';
import Logger from '../logger';
import { getSettings } from '../settings';
import env from '../env';
import {
    classifyOrder,
    isComplexOrder,
    type OrderCategory,
} from './llmClassifier';

export { isComplexOrder };

/**
 * Routage LLM — choisir le modèle ET le régime de raisonnement par requête.
 *
 * Profils (`settings.json llm.profile`) : `custom` (llama-server local),
 * `deepseek`, `claude` (presets cloud), ou `auto`. En `auto`, un classifieur
 * (llmClassifier.ts : chemin court 0 ms → LLM éclair → heuristique) trie :
 *  - `domotique` / `conversation` → local, **thinking coupé**
 *    (chat_template_kwargs.enable_thinking=false — mesuré : 0,27 s au lieu de
 *    plusieurs secondes de raisonnement par tour sur Qwen3.6) ;
 *  - `complexe` → `llm.smartProfile` (clé cloud) sinon local avec thinking.
 *
 * `llm.thinking` force le régime : 'auto' (défaut), 'always', 'never'.
 * `llm.fastBaseUrl`/`llm.fastModel` (optionnels) : un second petit serveur
 * (ex. llama-server Qwen3-1.7B sur :11436) qui prend la classification ET la
 * catégorie domotique — sinon tout passe par le modèle local principal.
 *
 * Tout est OpenAI-compatible : un seul SDK, clients en cache par (URL, clé).
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
    /** Catégorie détectée (auto) — pour le journal/les logs. */
    category?: OrderCategory;
    /**
     * Corps additionnel à joindre à chat.completions.create — porte
     * chat_template_kwargs pour couper le thinking sur le local. Vide pour
     * les presets cloud (paramètre inconnu chez eux).
     */
    extraBody: Record<string, unknown>;
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

type LlmSettings = ReturnType<typeof getSettings>['llm'] & {
    profile?: string;
    smartProfile?: string;
    thinking?: string;
    fastBaseUrl?: string;
    fastModel?: string;
};

const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/** Le régime de thinking demandé s'applique-t-il ? (local uniquement) */
function thinkingBody(
    settings: LlmSettings,
    wantThinking: boolean,
): Record<string, unknown> {
    const policy = settings.thinking ?? 'auto';
    if (policy === 'always') return {};
    if (policy === 'never') return NO_THINKING;
    return wantThinking ? {} : NO_THINKING;
}

function customChoice(settings: LlmSettings, wantThinking: boolean): LlmChoice {
    return {
        client: clientFor(
            settings.baseUrl ?? env.LLM_BASE_URL,
            env.LLM_API_KEY,
        ),
        model: settings.model || env.LLM_MODEL,
        profile: 'custom',
        extraBody: thinkingBody(settings, wantThinking),
    };
}

/** Petit modèle dédié (classification + domotique) si configuré. */
function fastChoice(settings: LlmSettings): LlmChoice | null {
    if (!settings.fastBaseUrl || !settings.fastModel) return null;
    return {
        client: clientFor(settings.fastBaseUrl, env.LLM_API_KEY),
        model: settings.fastModel,
        profile: 'fast',
        extraBody: thinkingBody(settings, false),
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
        extraBody: {},
    };
}

/**
 * Choisit le LLM pour un ordre, selon `llm.profile` :
 * `custom` (défaut), `deepseek`, `claude`, ou `auto` (classification).
 */
export async function resolveLlm(order?: string): Promise<LlmChoice> {
    const settings = getSettings().llm as LlmSettings;
    const profile = settings.profile ?? 'custom';

    if (profile !== 'auto') {
        if (profile !== 'custom') {
            const choice = presetChoice(profile);
            if (choice) return choice;
        }
        // Hors auto : le thinking suit la politique, régime « réfléchi ».
        return customChoice(settings, true);
    }

    if (!order) return customChoice(settings, false);

    const fast = fastChoice(settings);
    const classifier = fast ?? customChoice(settings, false);
    const { category, source } = await classifyOrder(
        order,
        classifier.client,
        classifier.model,
    );
    Logger.info(`[llm] ordre classé "${category}" (${source})`);

    if (category === 'complexe') {
        const smart = presetChoice(settings.smartProfile ?? 'claude');
        if (smart) return { ...smart, category };
        return { ...customChoice(settings, true), category };
    }
    // domotique / conversation → le petit modèle s'il existe, sinon le
    // local principal — thinking coupé dans les deux cas.
    if (category === 'domotique' && fast) return { ...fast, category };
    return { ...customChoice(settings, false), category };
}
