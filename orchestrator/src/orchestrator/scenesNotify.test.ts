import assert from 'assert';
import { runActionList, type SceneAction } from './scenes';

// Regression: a scene `_notify` action must reach context.notify with the
// resolved message. The bug was that some scene-runner call sites (the
// LLM `scene_trigger` path and the direct callTool path in orchestrator/index.ts)
// built the SceneContext WITHOUT a `notify` function, so `_notify` silently
// no-op'd while the rest of the scene ran fine.
async function run(): Promise<void> {
    // 1. notify present → invoked with the message
    {
        const notified: string[] = [];
        const calls: string[] = [];
        const actions: SceneAction[] = [
            { tool: 'unlock_door', args: {} },
            { tool: '_notify', args: { message: 'Bienvenue' } },
        ];
        await runActionList(
            actions,
            'test-notify',
            async (tool) => {
                calls.push(tool);
                return null;
            },
            { notify: async (m) => void notified.push(m) },
        );
        assert.deepStrictEqual(notified, ['Bienvenue']);
        // non-virtual action still routed to callTool
        assert.deepStrictEqual(calls, ['unlock_door']);
    }

    // 2. notify absent → no throw, action is a silent no-op (the old buggy path)
    {
        const actions: SceneAction[] = [
            { tool: '_notify', args: { message: 'sans contexte' } },
        ];
        await runActionList(actions, 'test-no-notify', async () => null, {});
        // reaching here without throwing is the assertion
    }

    console.log('scenesNotify.test.ts OK');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
