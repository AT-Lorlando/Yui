// orchestrator/src/orchestrator/animation/dynamicScene.test.ts
import assert from 'assert';
import { buildDynamicSceneBody } from './dynamicScene';

function run(): void {
    const body = buildDynamicSceneBody({
        name: 'Yui Floating Salon',
        groupRid: 'room-uuid',
        lightRids: ['l1', 'l2'],
        palette: ['#FF0000', '#0000FF'],
        speed: 0.4,
    });

    assert.strictEqual(body.metadata.name, 'Yui Floating Salon');
    assert.strictEqual(body.group.rid, 'room-uuid');
    assert.strictEqual(body.group.rtype, 'room');
    // one action per light, each with a colour
    assert.strictEqual(body.actions.length, 2);
    assert.strictEqual(body.actions[0].target.rid, 'l1');
    assert.ok(body.actions[0].action.color.xy);
    // palette carries the colours for dynamic drift
    assert.strictEqual(body.palette.color.length, 2);
    assert.strictEqual(body.speed, 0.4);

    console.log('All dynamicScene tests passed');
}

run();
