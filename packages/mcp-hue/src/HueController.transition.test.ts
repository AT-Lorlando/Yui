// packages/mcp-hue/src/HueController.transition.test.ts
import assert from 'assert';
import HueController from './HueController';

async function run(): Promise<void> {
    let captured: any = null;
    const fakeApi = {
        lights: {
            getLight: async () => ({ id: 5, name: 'L', state: {} }),
            setLightState: async (_id: number, state: any) => {
                captured = state.getPayload();
            },
        },
    };
    const ctl = new HueController(fakeApi as any);

    // 2500ms → 25 deciseconds in the Hue payload.
    await ctl.setLightColor(5, '#FF0000', 2500);
    assert.strictEqual(captured.transitiontime, 25);

    console.log('All HueController transition tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
