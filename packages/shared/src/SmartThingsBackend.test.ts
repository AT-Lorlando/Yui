// packages/shared/src/SmartThingsBackend.test.ts
import assert from 'assert';
import { SmartThingsBackend, parseStatus } from './SmartThingsBackend';
import type { StCommand, StDevice } from './SmartThingsClient';

function fakeClient(health: 'ONLINE' | 'OFFLINE' = 'ONLINE', status: any = {}) {
    const cmds: StCommand[][] = [];
    let refreshed = 0;
    const client: StDevice = {
        async sendCommands(c) {
            cmds.push(c);
        },
        async getStatusRaw() {
            return status;
        },
        async getHealth() {
            return health;
        },
        async refresh() {
            refreshed++;
        },
    };
    return { cmds, client, refreshed: () => refreshed };
}

const CFG = {
    mac: 'D0:D0:03:30:48:4B',
    ip: '10.0.0.133',
    chromecastInput: 'HDMI3',
    inputs: { HDMI3: 'Chromecast' },
};

async function run() {
    // parseStatus depuis un payload réel
    {
        const raw = {
            main: {
                switch: { switch: { value: 'on' } },
                audioVolume: { volume: { value: 17 } },
                audioMute: { mute: { value: 'unmuted' } },
                'samsungvd.mediaInputSource': {
                    inputSource: { value: 'HDMI3' },
                },
            },
        };
        assert.deepStrictEqual(parseStatus(raw), {
            power: 'on',
            volume: 17,
            muted: false,
            input: 'HDMI3',
        });
    }
    // setVolume → commande audioVolume.setVolume clampée
    {
        const { cmds, client } = fakeClient();
        const b = new SmartThingsBackend(client, CFG);
        await b.setVolume(150);
        assert.deepStrictEqual(cmds[0], [
            {
                component: 'main',
                capability: 'audioVolume',
                command: 'setVolume',
                arguments: [100],
            },
        ]);
    }
    // setMute(true) / setMute(false)
    {
        const { cmds, client } = fakeClient();
        const b = new SmartThingsBackend(client, CFG);
        await b.setMute(true);
        await b.setMute(false);
        assert.strictEqual(cmds[0][0].command, 'mute');
        assert.strictEqual(cmds[1][0].command, 'unmute');
    }
    // setInput → samsungvd.mediaInputSource.setInputSource
    {
        const { cmds, client } = fakeClient();
        const b = new SmartThingsBackend(client, CFG);
        await b.setInput('HDMI3');
        assert.deepStrictEqual(cmds[0], [
            {
                component: 'main',
                capability: 'samsungvd.mediaInputSource',
                command: 'setInputSource',
                arguments: ['HDMI3'],
            },
        ]);
    }
    // status() quand OFFLINE → {power:'off'} sans refresh
    {
        const { client, refreshed } = fakeClient('OFFLINE');
        const b = new SmartThingsBackend(client, CFG, { refreshSettleMs: 0 });
        assert.deepStrictEqual(await b.status(), { power: 'off' });
        assert.strictEqual(refreshed(), 0);
    }
    // ensureOn() quand déjà ONLINE → bascule input, pas de WoL
    {
        const { cmds, client } = fakeClient('ONLINE');
        const b = new SmartThingsBackend(client, CFG);
        const msg = await b.ensureOn();
        assert.match(msg, /déjà allumée/);
        assert.strictEqual(cmds[0][0].command, 'setInputSource');
    }
    console.log('All SmartThingsBackend tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
