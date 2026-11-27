import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-wakeruns-'));
process.env.YUI_DATA_DIR = tmp;

const store = require('./store') as typeof import('./store');
const { WakeupRunner, WakeupNotFoundError } =
    require('./runner') as typeof import('./runner');

const at = (h: number, m: number, s = 0) =>
    new Date(2026, 10, 27, h, m, s).getTime();

function setup(
    opts: {
        roomOn?: boolean;
        agendaDown?: boolean;
        phone?: boolean;
        listFails?: boolean;
        listResult?: unknown;
        setError?: boolean;
    } = {},
) {
    fs.rmSync(path.join(tmp, 'state'), { recursive: true, force: true });
    store.writeWakeups([
        {
            id: 'f',
            name: 'F',
            trigger: opts.phone
                ? { kind: 'phone' }
                : {
                      kind: 'fixed',
                      time: '07:00',
                      days: [0, 1, 2, 3, 4, 5, 6],
                  },
        },
    ]);
    const calls: { name: string; args: any }[] = [];
    const notified: string[] = [];
    const spoken: { text: string; device: string }[] = [];
    let clock = at(6, 44);
    let presence: 'home' | 'away' | 'unknown' = 'home';
    const handled: number[] = [];
    const mkRunner = () =>
        new WakeupRunner({
            callTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'list_lights' && opts.listFails)
                    throw new Error('hue KO');
                if (name === 'list_lights' && 'listResult' in opts)
                    return opts.listResult;
                if (name === 'set_lights' && opts.setError)
                    return 'Error: bridge injoignable';
                if (name === 'list_lights')
                    return [
                        {
                            name: 'a',
                            room: 'Chambre',
                            state: { on: !!opts.roomOn },
                        },
                        { name: 'b', room: 'Salon', state: { on: true } },
                    ];
                if (opts.agendaDown) throw new Error('agenda KO');
                return [];
            },
            notify: async (t) => void notified.push(t),
            speak: async (text, device) => {
                spoken.push({ text, device });
                return true;
            },
            presence: () => presence,
            onWakeHandled: (t) => void handled.push(t),
            now: () => clock,
            sleep: async () => {},
        });
    return {
        handled,
        calls,
        notified,
        spoken,
        mkRunner,
        setNow: (t: number) => (clock = t),
        setPresence: (p: typeof presence) => (presence = p),
        sets: () => calls.filter((c) => c.name === 'set_lights'),
    };
}

async function run() {
    // montée à 06:45
    let s = setup();
    let r = s.mkRunner();
    await r.tick();
    assert.strictEqual(s.calls.length, 0);
    s.setNow(at(6, 45));
    await r.tick();
    assert.strictEqual(s.calls[0].name, 'list_lights');
    const sets = s.sets();
    assert.strictEqual(sets.length, 2);
    assert.deepStrictEqual(sets[0].args, {
        target: 'Chambre',
        on: true,
        color: '#ff8a3d',
        brightness: 1,
        transitionMs: 0,
    });
    assert.deepStrictEqual(sets[1].args, {
        target: 'Chambre',
        colorTemp: 2700,
        brightness: 80,
        transitionMs: 898_500,
    });
    await r.tick();
    assert.strictEqual(s.sets().length, 2, 'pas de seconde montée');

    // chambre déjà allumée : aucune écriture, marque posée
    s = setup({ roomOn: true });
    r = s.mkRunner();
    s.setNow(at(6, 45));
    await r.tick();
    assert.strictEqual(s.sets().length, 0);
    await r.tick();
    assert.strictEqual(
        s.calls.filter((c) => c.name === 'list_lights').length,
        1,
    );

    // point du matin, présent
    s = setup();
    r = s.mkRunner();
    s.setNow(at(6, 50));
    await r.tick(); // l'occurrence est vue avant T
    s.setNow(at(7, 5));
    await r.tick();
    assert.strictEqual(s.notified.length, 1);
    assert.strictEqual(s.spoken.length, 1);
    assert.strictEqual(s.spoken[0].device, 'Chambre');
    await r.tick();
    assert.strictEqual(s.notified.length, 1);

    // absent : notif seule
    s = setup();
    r = s.mkRunner();
    s.setPresence('away');
    s.setNow(at(6, 50));
    await r.tick();
    s.setNow(at(7, 5));
    await r.tick();
    assert.strictEqual(s.notified.length, 1);
    assert.strictEqual(s.spoken.length, 0);

    // redémarrage : second runner, mêmes données
    s = setup();
    r = s.mkRunner();
    s.setNow(at(6, 45));
    await r.tick();
    s.setNow(at(7, 5));
    await r.tick();
    const n = s.calls.length;
    const r2 = s.mkRunner();
    s.setNow(at(6, 46));
    await r2.tick();
    s.setNow(at(7, 6));
    await r2.tick();
    assert.strictEqual(s.calls.length, n);
    assert.strictEqual(s.notified.length, 1);
    assert.strictEqual(s.spoken.length, 1);

    // démarrage tardif : pas de montée, point du matin si < T + 30 min
    s = setup();
    r = s.mkRunner();
    s.setNow(at(7, 10));
    await r.tick();
    assert.strictEqual(s.sets().length, 0);
    assert.strictEqual(s.notified.length, 1);
    s = setup();
    r = s.mkRunner();
    s.setNow(at(7, 40));
    await r.tick();
    assert.strictEqual(s.calls.length, 0);
    assert.strictEqual(s.notified.length, 0);

    // agenda en panne : le point part quand même
    s = setup({ agendaDown: true });
    r = s.mkRunner();
    s.setNow(at(6, 50));
    await r.tick();
    s.setNow(at(7, 5));
    await r.tick();
    assert.strictEqual(s.notified.length, 1);
    assert.ok(s.notified[0].includes("Rien à l'agenda ajd"), s.notified[0]);

    // une action qui échoue ne fait pas lever tick()
    s = setup();
    r = s.mkRunner();
    const bad = new WakeupRunner({
        callTool: async () => {
            throw new Error('boom');
        },
        notify: async () => {
            throw new Error('boom');
        },
        speak: async () => {
            throw new Error('boom');
        },
        presence: () => 'home',
        now: () => at(6, 45),
        sleep: async () => {},
    });
    await bad.tick();

    // next() et test()
    s = setup();
    r = s.mkRunner();
    assert.strictEqual(r.next()[0].at, at(7, 0));
    await assert.rejects(() => r.test('nope'), WakeupNotFoundError);
    s.setNow(at(21, 0));
    await r.test('f');
    assert.strictEqual(s.sets().length, 2);
    assert.strictEqual(s.sets()[1].args.transitionMs, 58_500);
    assert.strictEqual(s.notified.length, 1);
    assert.strictEqual(
        fs.existsSync(path.join(tmp, 'state', 'wakeup-runs.json')),
        false,
        'test() ne pose aucune marque',
    );
    // alarme téléphone vue puis coupée / déplacée : rien ne part
    for (const moved of [false, true]) {
        s = setup({ phone: true });
        r = s.mkRunner();
        s.setNow(at(22, 0));
        store.writePhoneAlarm(
            new Date(2026, 10, 28, 7, 0).getTime(),
            't',
            at(22, 0),
        );
        await r.tick();
        store.writePhoneAlarm(
            moved ? new Date(2026, 10, 29, 7, 0).getTime() : null,
            't',
            at(22, 1),
        );
        s.setNow(new Date(2026, 10, 28, 6, 45).getTime());
        await r.tick();
        s.setNow(new Date(2026, 10, 28, 7, 5).getTime());
        await r.tick();
        assert.strictEqual(s.calls.length, 0, `moved=${moved}`);
        assert.strictEqual(s.notified.length, 0);
    }

    // list_lights en échec : pas de montée, pas de marque, retry au tick suivant
    s = setup({ listFails: true });
    r = s.mkRunner();
    s.setNow(at(6, 45));
    await r.tick();
    assert.strictEqual(s.sets().length, 0);
    const runsF = JSON.parse(
        fs.readFileSync(path.join(tmp, 'state', 'wakeup-runs.json'), 'utf8'),
    );
    assert.strictEqual(Object.values<any>(runsF)[0].lights, undefined);
    await r.tick();
    assert.strictEqual(
        s.calls.filter((c) => c.name === 'list_lights').length,
        2,
    );

    // montée faite : le moment « premières lumières » est neutralisé pour la journée
    s = setup();
    r = s.mkRunner();
    s.setNow(at(6, 45));
    await r.tick();
    assert.deepStrictEqual(s.handled, [at(6, 45)]);
    // point du matin seul (pas de montée) : idem
    s = setup();
    r = s.mkRunner();
    s.setNow(at(7, 10));
    await r.tick();
    assert.strictEqual(s.handled.length, 1);

    // absent : pas de montée, marque posée (pas de nouvelle tentative)
    s = setup();
    r = s.mkRunner();
    s.setPresence('away');
    s.setNow(at(6, 45));
    await r.tick();
    assert.strictEqual(s.sets().length, 0);
    await r.tick();
    s.setNow(at(6, 50));
    await r.tick();
    assert.strictEqual(
        s.calls.filter((c) => c.name === 'list_lights').length,
        0,
    );
    assert.strictEqual(s.sets().length, 0);
    // présence inconnue : la montée part
    s = setup();
    r = s.mkRunner();
    s.setPresence('unknown');
    s.setNow(at(6, 45));
    await r.tick();
    assert.strictEqual(s.sets().length, 2);

    // list_lights rend une erreur MCP (chaîne), du texte, ou aucune lampe de la pièce : inconnu
    for (const listResult of [
        'Error: hue KO',
        'pas du json',
        '[]',
        [{ name: 'b', room: 'Salon', state: { on: true } }],
    ]) {
        s = setup({ listResult });
        r = s.mkRunner();
        s.setNow(at(6, 45));
        await r.tick();
        assert.strictEqual(s.sets().length, 0, JSON.stringify(listResult));
        const runsU = JSON.parse(
            fs.readFileSync(
                path.join(tmp, 'state', 'wakeup-runs.json'),
                'utf8',
            ),
        );
        assert.strictEqual(
            Object.values<any>(runsU)[0].lights,
            undefined,
            'pas de marque',
        );
        await r.tick();
        assert.strictEqual(
            s.calls.filter((c) => c.name === 'list_lights').length,
            2,
            'retry au tick suivant',
        );
    }

    // set_lights en erreur (chaîne « Error… ») : avertissement, pas de succès journalisé
    const logger = require('../../logger').default;
    const warns: string[] = [];
    const infos: string[] = [];
    const ow = logger.warn;
    const oi = logger.info;
    logger.warn = (m: string) => void warns.push(String(m));
    logger.info = (m: string) => void infos.push(String(m));
    try {
        s = setup({ setError: true });
        r = s.mkRunner();
        s.setNow(at(6, 45));
        await r.tick();
    } finally {
        logger.warn = ow;
        logger.info = oi;
    }
    assert.ok(
        warns.some((w) => w.includes('bridge injoignable')),
        warns.join('|'),
    );
    assert.ok(!infos.some((i) => i.includes('montée')), infos.join('|'));
    console.log('runner.test.ts ok');
}
run().catch((e) => {
    console.error(e);
    process.exit(1);
});
