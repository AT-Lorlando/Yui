import assert from 'assert';
import {
    bricksView,
    isBrickEnabled,
    brickSetting,
    registerConnectorBricks,
} from './bricks';

registerConnectorBricks([
    {
        id: 'weather',
        name: 'Météo',
        description: '',
        defaultEnabled: true,
        settings: [
            { key: 'maxPerHour', label: '', type: 'number', default: 6 },
        ],
    },
]);

const cfg = {
    bricks: {
        'external:koya': { enabled: false, settings: { maxPerHour: 2 } },
    },
};

assert.strictEqual(isBrickEnabled(cfg, 'external:koya'), false);
assert.strictEqual(
    isBrickEnabled(cfg, 'external:genkin'),
    true,
    'externe inconnue : active par défaut',
);
assert.strictEqual(brickSetting(cfg, 'external:koya', 'maxPerHour', 6), 2);
assert.strictEqual(
    brickSetting(cfg, 'weather', 'maxPerHour', 0),
    6,
    'défaut déclaré par la brique',
);
const view = bricksView(cfg);
assert.ok(
    view.some(
        (b) => b.id === 'external:koya' && b.kind === 'external' && !b.enabled,
    ),
);
assert.ok(view.some((b) => b.id === 'weather'));

console.log('All bricks tests passed');
