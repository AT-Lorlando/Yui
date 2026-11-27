import assert from 'assert';
import { CalendarClient } from './CalendarClient';
import { taggedCalendars, taggedView } from './tagged';

const priv = { yuiRule: 'r1', yuiDate: '2026-12-31' };

// timed
assert.deepStrictEqual(
    taggedView(
        {
            id: 'e1',
            summary: 'Rule',
            start: { dateTime: '2026-12-31T14:00:00+01:00' },
            end: { dateTime: '2026-12-31T14:30:00+01:00' },
            extendedProperties: { private: priv },
        },
        'primary',
    ),
    {
        id: 'e1',
        calendarId: 'primary',
        title: 'Rule',
        date: '2026-12-31',
        allDay: false,
        start: '14:00',
        durationMin: 30,
        yuiRule: 'r1',
        yuiDate: '2026-12-31',
        yuiInstance: null,
    },
);

// timed in UTC representation still reads Paris time
const utc = taggedView(
    {
        id: 'e2',
        start: { dateTime: '2026-07-01T12:00:00Z' },
        end: { dateTime: '2026-07-01T13:00:00Z' },
        extendedProperties: { private: priv },
    },
    'c',
);
assert.strictEqual(utc?.start, '14:00');
assert.strictEqual(utc?.date, '2026-07-01');
assert.strictEqual(utc?.durationMin, 60);

// all-day
assert.deepStrictEqual(
    taggedView(
        {
            id: 'e3',
            summary: 'Day',
            start: { date: '2026-12-31' },
            end: { date: '2027-01-01' },
            extendedProperties: { private: priv },
        },
        'primary',
    ),
    {
        id: 'e3',
        calendarId: 'primary',
        title: 'Day',
        date: '2026-12-31',
        allDay: true,
        start: null,
        durationMin: null,
        yuiRule: 'r1',
        yuiDate: '2026-12-31',
        yuiInstance: null,
    },
);

// untagged / cancelled
assert.strictEqual(
    taggedView({ id: 'x', start: { date: '2026-12-31' } }, 'primary'),
    null,
);
assert.strictEqual(
    taggedView(
        {
            id: 'y',
            status: 'cancelled',
            start: { date: '2026-12-31' },
            extendedProperties: { private: priv },
        },
        'primary',
    ),
    null,
);

// Agendas lisibles : l'agenda principal est exposé sous l'alias 'primary'
assert.deepStrictEqual(
    taggedCalendars([
        { id: 'moi@gmail.com', primary: true, accessRole: 'owner' },
        { id: 'pro@group.calendar.google.com', accessRole: 'writer' },
        {
            id: 'fr.french#holiday@group.v.calendar.google.com',
            accessRole: 'reader',
        },
        { accessRole: 'owner' },
    ]),
    {
        primaryId: 'moi@gmail.com',
        calendars: [
            { fetchId: 'moi@gmail.com', reportId: 'primary' },
            {
                fetchId: 'pro@group.calendar.google.com',
                reportId: 'pro@group.calendar.google.com',
            },
        ],
    },
);
assert.deepStrictEqual(taggedCalendars([{ id: 'a', accessRole: 'owner' }]), {
    primaryId: null,
    calendars: [{ fetchId: 'a', reportId: 'a' }],
});

// yuiInstance exposé quand présent
assert.strictEqual(
    taggedView(
        {
            id: 'e4',
            start: { date: '2026-12-31' },
            extendedProperties: { private: { ...priv, yuiInstance: 'prod' } },
        },
        'primary',
    )?.yuiInstance,
    'prod',
);

// listTaggedEvents : agendas masqués compris, `scanned` = agendas parcourus
async function listing(): Promise<void> {
    const client = new CalendarClient({} as never);
    let listArgs: Record<string, unknown> | null = null;
    const fetched: string[] = [];
    (client as unknown as { cal: unknown }).cal = {
        calendarList: {
            list: async (args: Record<string, unknown>) => {
                listArgs = args;
                return {
                    data: {
                        items: [
                            {
                                id: 'moi@gmail.com',
                                primary: true,
                                accessRole: 'owner',
                            },
                            {
                                id: 'cache@group.calendar.google.com',
                                accessRole: 'owner',
                                hidden: true,
                            },
                            {
                                id: 'ro@group.calendar.google.com',
                                accessRole: 'reader',
                            },
                        ],
                    },
                };
            },
        },
        events: {
            list: async (args: { calendarId: string }) => {
                fetched.push(args.calendarId);
                return {
                    data: {
                        items: [
                            {
                                id: `ev-${args.calendarId}`,
                                start: { date: '2026-12-31' },
                                extendedProperties: {
                                    private: { ...priv, yuiInstance: 'me' },
                                },
                            },
                        ],
                    },
                };
            },
        },
    };
    const res = await client.listTaggedEvents('2026-12-01', '2026-12-31');
    assert.strictEqual(listArgs!.showHidden, true);
    assert.deepStrictEqual(fetched.sort(), [
        'cache@group.calendar.google.com',
        'moi@gmail.com',
    ]);
    assert.deepStrictEqual(res.scanned, [
        'primary',
        'cache@group.calendar.google.com',
    ]);
    assert.strictEqual(res.primaryId, 'moi@gmail.com');
    assert.ok(res.events.every((e) => e.yuiInstance === 'me'));
}

listing()
    .then(() => console.log('tagged.test OK'))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
