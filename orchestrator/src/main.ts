import './bootstrap'; // load .env + settings.json and patch process.env — must be first
import { startBackupSchedule } from './orchestrator/dataBackup';
import './env';
import { Orchestrator, buildServerConfigs } from './orchestrator';
import { initProactive } from './orchestrator/proactive';
import {
    applyOrchestratorEnv,
    loadIntegrations,
} from './orchestrator/integrations';
import { initHueRemotes } from './orchestrator/hueRemotes';
import { InputSource, StdinSource, HttpSource } from './input';
import {
    initAutomations,
    loadAutomations,
    addAutomation,
    deleteAutomation,
    toggleAutomation,
    updateAutomation,
    runAutomation,
    type OutputChannel,
} from './orchestrator/automations';
import { sendNotification, speakText } from './orchestrator/notify';
import { PresenceManager, getHomeCoords } from './orchestrator/presence';
import {
    loadPresenceConfig,
    savePresenceConfig,
} from './orchestrator/presenceConfig';
import { createPresenceRulesEngine } from './orchestrator/presenceRules';
import { AgendaSecretary } from './orchestrator/agendaSecretary';
import {
    listScenes,
    createScene,
    updateScene,
    deleteScene,
    runScene,
    toggleFavorite,
} from './orchestrator/scenes';
import Logger from './logger';
import {
    listConversations,
    readStoryEntries,
    getIndexEntry,
    getBranches,
    storyFileExists,
} from './orchestrator/storyArchive';
import type { ConversationsHandler } from './input/InputSource';
import { createDashboardProvider } from './orchestrator/dashboard';

// Parole hors conversation (automations, proactivité) : voir notify.ts.
const speakViaPipeline = (text: string): Promise<void> =>
    speakText(text).then(() => undefined);

async function main() {
    // Clés saisies depuis l'app (Claude, DeepSeek, La Poste…) — avant tout
    // consommateur ; ré-appliquées à chaque PUT /integrations.
    applyOrchestratorEnv(loadIntegrations());
    Logger.info('Starting Yui…');

    const servers = buildServerConfigs();
    const orchestrator = new Orchestrator(servers);
    await orchestrator.init();

    // Sauvegarde quotidienne de data/ (config + credentials + mémoire).
    startBackupSchedule();

    const handler = (
        order: string,
        reset?: boolean,
        outputChannel?: import('./orchestrator/automations').OutputChannel,
        conversationId?: string,
    ) => orchestrator.processOrder(order, reset, outputChannel, conversationId);
    const streamHandler: import('./input/InputSource').StreamHandler = (
        order,
        options,
        reset,
    ) =>
        orchestrator.processOrderStream(
            order,
            options,
            reset,
            options?.outputChannel,
        );
    const statusHandler = () => orchestrator.getStatus();
    const deviceHandler = (toolName: string, args: Record<string, unknown>) =>
        orchestrator.callTool(toolName, args);

    const scenesHandler = {
        list: listScenes,
        trigger: (id: string) =>
            runScene(id, deviceHandler, {
                presenceState: presence.getState(),
                notify: (msg) => sendNotification(msg),
                callToolRaw: (t, a) => orchestrator.callToolRaw(t, a ?? {}),
            }),
        create: createScene,
        update: updateScene,
        remove: deleteScene,
        toggleFavorite,
    };

    const toolsHandler = {
        list: () => orchestrator.getTools(),
        call: (name: string, args: Record<string, unknown>) =>
            orchestrator.callTool(name, args),
        callRaw: (name: string, args: Record<string, unknown>) =>
            orchestrator.callToolRaw(name, args),
    };

    // Presence manager — detects departure (MAC) and arrival (GPS)
    // Triggers scenes directly — no LLM involved
    const presence = new PresenceManager();
    presence.start();

    const makeSceneRunner = (id: string) =>
        runScene(id, deviceHandler, {
            presenceState: presence.getState(),
            notify: (msg) => sendNotification(msg),
            callToolRaw: (t, a) => orchestrator.callToolRaw(t, a ?? {}),
        });

    const automationsHandler = {
        list: loadAutomations,
        add: addAutomation,
        update: updateAutomation,
        toggle: toggleAutomation,
        remove: deleteAutomation,
        run: (id: string) => runAutomation(id),
    };

    const conversationsHandler: ConversationsHandler = {
        list: (scope) =>
            listConversations(scope).filter((e) => storyFileExists(e.id)),
        get: (id) => ({
            entries: readStoryEntries(id),
            meta: getIndexEntry(id),
            branches: getBranches(id),
        }),
        simulate: (id, body, options) =>
            orchestrator.simulate(id, body, options),
    };

    // Automations: fires cron/delay jobs, dispatches response to the configured channel
    async function dispatchOutput(
        text: string,
        channel: OutputChannel,
    ): Promise<void> {
        if (channel === 'cast') return speakViaPipeline(text);
        if (channel === 'notify') return sendNotification(text);
        // 'none' → silent automation, no output
    }
    initAutomations(handler, dispatchOutput, makeSceneRunner, speakViaPipeline);

    // Proactivité : observe présence/météo/agenda/mail et notifie/agit de sa propre initiative
    const proactive = initProactive({
        complete: (system, user) => orchestrator.complete(system, user),
        notify: (text) => sendNotification(text),
        speak: (text) => speakViaPipeline(text),
        presenceState: () => presence.getState(),
        subscribePresence: (cb) => presence.onChange(cb),
        deviceHandler: (tool, args) => orchestrator.callTool(tool, args ?? {}),
        runScene: makeSceneRunner,
    });

    // Hue remotes — listen to bridge SSE for button + dial events
    const hueRemotes = await initHueRemotes({
        callTool: (name, args) => orchestrator.callTool(name, args),
        presenceState: () => presence.getState(),
    });

    const presenceRules = createPresenceRulesEngine({
        callTool: (t, a) => orchestrator.callTool(t, a ?? {}),
        context: () => ({
            presenceState: presence.getState(),
            notify: (msg: string) => sendNotification(msg),
            callToolRaw: (t: string, a?: Record<string, unknown>) =>
                orchestrator.callToolRaw(t, a ?? {}),
        }),
        arrivalScene: process.env.PRESENCE_ARRIVAL_SCENE,
        departureScene: process.env.PRESENCE_DEPARTURE_SCENE,
    });
    presence.onEvent((event) => presenceRules.handleEvent(event));

    const buildConfigDto = () => {
        const { lat, lng } = getHomeCoords();
        const c = loadPresenceConfig();
        return { homeLat: lat, homeLng: lng, geofence: c.geofence, mac: c.mac };
    };
    const presenceHandler = {
        getState: () => presence.getState(),
        handleGeofence: (t: string) => presence.handleGeofence(t),
        getConfig: buildConfigDto,
        setConfig: (patch: any) => {
            savePresenceConfig(patch);
            return buildConfigDto();
        },
        listRules: () => presenceRules.list(),
        replaceRules: (rules: any) => presenceRules.replace(rules),
    };

    const agendaSecretary = new AgendaSecretary({
        callTool: (tool, args) => orchestrator.callTool(tool, args ?? {}),
        complete: (system, user) => orchestrator.complete(system, user),
    });

    const dashboardProvider = createDashboardProvider({
        callTool: (tool, args) => orchestrator.callTool(tool, args ?? {}),
        mailTriage: () => proactive.getTriageSummary(),
        presenceState: () => presence.getState(),
        automations: () => loadAutomations(),
        proactiveLastMessage: () => proactive.getLastMessage(),
        mailQuery: () => proactive.getMailQuery(),
        judgedAgenda: () => agendaSecretary.getAgenda(),
        agendaPending: () => agendaSecretary.isPending(),
        todoProject: process.env.DASHBOARD_TODO_PROJECT ?? 'todos/Personal',
    });

    const sources: InputSource[] = [new StdinSource(), new HttpSource()];
    for (const source of sources) {
        await source.start(
            handler,
            streamHandler,
            statusHandler,
            deviceHandler,
            scenesHandler,
            toolsHandler,
            automationsHandler,
            presenceHandler,
            conversationsHandler,
            { reconnect: (name: string) => orchestrator.reconnectServer(name) },
            {
                reload: () => proactive.reload(),
                bricks: () => proactive.getBricks(),
                journal: (limit?: number) => proactive.getJournal(limit),
                feedback: (id: string, value: 'up' | 'down') =>
                    proactive.setFeedback(id, value),
                situation: () => proactive.getSituation(),
                triage: () => ({
                    ...proactive.concierge.getState(),
                    pending: proactive.concierge.pending(),
                    openDoubts: proactive.concierge.openDoubts(),
                    categories: proactive.concierge.categories(),
                }),
                triageResolveDoubt: (id, opts) =>
                    proactive.concierge.resolveDoubt(id, opts),
                triageScan: (query?: string, max?: number) =>
                    proactive.concierge.scan(query, max),
                triageApply: (filter?: {
                    category?: string;
                    mailIds?: string[];
                }) => proactive.concierge.apply(filter),
                triageCorrect: (mailId: string, category: string) =>
                    proactive.concierge.correct(mailId, category),
                ingest: (events) => proactive.ingestAll(events),
            },
            () => dashboardProvider(),
        );
    }

    const shutdown = async (signal: string) => {
        Logger.info(`Received ${signal}, shutting down…`);
        presence.stop();
        presenceRules.stop();
        proactive.stop();
        hueRemotes.stop();
        for (const source of sources) {
            await source.stop();
        }
        await orchestrator.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
