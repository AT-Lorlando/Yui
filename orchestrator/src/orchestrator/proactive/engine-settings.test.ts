// Précédence des réglages de connecteur : défauts déclarés ← section legacy de
// proactive.json ← écarts de brique. Ce que le poll utilise et ce que le
// dashboard affiche (getMailQuery) doivent sortir de la même résolution.
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProactiveConfig, ProactiveDeps } from './types';
import type { PresenceState } from '../presence';

// YUI_DATA_DIR posé AVANT de résoudre les modules : leurs dataPath() sont
// figés au chargement (même contrainte que engine-action.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-es-'));
const { ProactiveEngine } = require('./index') as typeof import('./index');
const { Dedup } = require('./dedup') as typeof import('./dedup');
const { HeldQueue } = require('./held') as typeof import('./held');
const { ProactiveJournal } = require('./journal') as typeof import('./journal');
const { DEFAULT_MAIL_QUERY } =
    require('./connectors/mail') as typeof import('./connectors/mail');

function cfg(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
    return {
        enabled: true,
        chattiness: 'normal',
        quietHours: { start: '23:00', end: '07:00' },
        digestTime: '07:00',
        defaultCooldownMin: 30,
        automationGuardWindowMin: 60,
        whitelist: [],
        ...over,
    };
}

const deps: ProactiveDeps = {
    complete: async () => '',
    notify: async () => {},
    speak: async () => {},
    presenceState: () => 'home' as PresenceState,
    subscribePresence: () => () => {},
    deviceHandler: async () => null,
    runScene: async () => ({ success: true }),
    now: () => new Date('2026-09-25T10:00:00').getTime(),
};

function engine(c: ProactiveConfig) {
    return new ProactiveEngine(c, deps, {
        dedup: new Dedup(),
        held: new HeldQueue(),
        journal: new ProactiveJournal(
            path.join(process.env.YUI_DATA_DIR!, 'journal.json'),
        ),
    });
}

function run(): void {
    // 1. brique > section legacy
    assert.strictEqual(
        engine(
            cfg({
                mail: { pollMinutes: 15, query: 'legacy-q' },
                bricks: { mail: { settings: { query: 'brick-q' } } },
            }),
        ).getMailQuery(),
        'brick-q',
    );

    // 2. section legacy seule > défaut déclaré par le connecteur
    assert.strictEqual(
        engine(
            cfg({ mail: { pollMinutes: 15, query: 'legacy-q' } }),
        ).getMailQuery(),
        'legacy-q',
    );

    // 3. ni l'une ni l'autre → défaut déclaré par le connecteur
    assert.strictEqual(engine(cfg()).getMailQuery(), DEFAULT_MAIL_QUERY);

    // 4. cadence : le réglage de brique est bien celui passé au runner
    const tuned = engine(
        cfg({ bricks: { weather: { settings: { pollMinutes: 7 } } } }),
    );
    assert.strictEqual(tuned.connectorPollMinutes('weather'), 7);
    assert.ok(
        tuned.getBricks().some((b) => b.id === 'weather' && b.enabled),
        'la brique météo reste listée et active',
    );
    assert.strictEqual(engine(cfg()).connectorPollMinutes('weather'), 30);
    // Connecteur événementiel : aucune cadence ; id inconnu : rien non plus.
    assert.strictEqual(
        engine(cfg()).connectorPollMinutes('presence'),
        undefined,
    );
    assert.strictEqual(engine(cfg()).connectorPollMinutes('nope'), undefined);

    console.log('All engine settings tests passed');
}

run();
