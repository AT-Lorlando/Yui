import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Registre isolé et FRAIS (un tmpdir partagé garde l'état du run précédent).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-llmrouter-'));
process.env.YUI_DATA_DIR = tmp;
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test';

import { initSettings, updateSettings } from '../settings';
import { resolveLlm } from './llmRouter';

// activeDir démarre à 'data' tant qu'initSettings n'a pas tourné — sans ça,
// un updateSettings de test écrirait dans le VRAI <cwd>/data du checkout.
initSettings({ dir: tmp });

async function run(): Promise<void> {
    // Profil custom : local, thinking coupé seulement si policy never
    updateSettings({ llm: { profile: 'custom', thinking: 'auto' } } as never);
    {
        const llm = await resolveLlm('éteins le salon');
        assert.strictEqual(llm.profile, 'custom');
        // Hors auto : régime réfléchi (pas de coupure)
        assert.deepStrictEqual(llm.extraBody, {});
    }
    updateSettings({ llm: { thinking: 'never' } } as never);
    {
        const llm = await resolveLlm('éteins le salon');
        assert.deepStrictEqual(llm.extraBody, {
            chat_template_kwargs: { enable_thinking: false },
        });
    }

    // Auto + domotique évidente : local SANS thinking (chemin court, 0 LLM)
    updateSettings({
        llm: { profile: 'auto', thinking: 'auto' },
    } as never);
    {
        const llm = await resolveLlm('allume les lumières du salon');
        assert.strictEqual(llm.profile, 'custom');
        assert.strictEqual(llm.category, 'domotique');
        assert.deepStrictEqual(llm.extraBody, {
            chat_template_kwargs: { enable_thinking: false },
        });
    }

    // Auto + complexe (heuristique : le classifieur LLM échoue en test —
    // baseUrl locale injoignable → repli) : smartProfile sans clé → local
    // AVEC thinking.
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_CLASSIFY_TIMEOUT_MS = '50';
    {
        const llm = await resolveLlm(
            'planifie ma semaine en fonction de mon agenda et de la météo',
        );
        assert.strictEqual(llm.profile, 'custom');
        assert.strictEqual(llm.category, 'complexe');
        assert.deepStrictEqual(llm.extraBody, {}, 'complexe → thinking permis');
    }

    // Preset avec clé : deepseek prioritaire, pas d'extraBody (param inconnu)
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    updateSettings({ llm: { profile: 'deepseek' } } as never);
    {
        const llm = await resolveLlm('peu importe');
        assert.strictEqual(llm.profile, 'deepseek');
        assert.deepStrictEqual(llm.extraBody, {});
    }

    // Modèle rapide configuré : la domotique part dessus
    updateSettings({
        llm: {
            profile: 'auto',
            fastBaseUrl: 'http://localhost:1',
            fastModel: 'petit',
        },
    } as never);
    {
        const llm = await resolveLlm('éteins la chambre');
        assert.strictEqual(llm.profile, 'fast');
        assert.strictEqual(llm.model, 'petit');
    }

    console.log('All llmRouter tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
