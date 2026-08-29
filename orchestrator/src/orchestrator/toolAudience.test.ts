import assert from 'assert';
import { toolAudience, isLlmVisible } from './toolAudience';

function run(): void {
    // Absent = visible partout (llm + app)
    assert.deepStrictEqual(toolAudience({}), ['llm', 'app']);
    assert.deepStrictEqual(toolAudience(undefined), ['llm', 'app']);
    assert.strictEqual(isLlmVisible({}), true);

    // Déclaré = tel quel
    assert.deepStrictEqual(toolAudience({ 'x-audience': ['system'] }), [
        'system',
    ]);
    assert.strictEqual(isLlmVisible({ 'x-audience': ['system'] }), false);
    assert.strictEqual(isLlmVisible({ 'x-audience': ['app'] }), false);
    assert.strictEqual(isLlmVisible({ 'x-audience': ['llm'] }), true);

    // Tableau vide = défaut (une annotation vide est un oubli, pas un masquage)
    assert.deepStrictEqual(toolAudience({ 'x-audience': [] }), ['llm', 'app']);

    console.log('All toolAudience tests passed');
}

run();
