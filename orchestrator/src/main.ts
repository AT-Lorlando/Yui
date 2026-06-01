import './env'; // load env first
import http from 'http';
import { Orchestrator, buildServerConfigs } from './orchestrator';
import { initProactive } from './orchestrator/proactive';
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
import { sendNotification } from './orchestrator/notify';
import { PresenceManager, type PresenceState } from './orchestrator/presence';
import {
    listScenes,
    createScene,
    updateScene,
    deleteScene,
    runScene,
    toggleFavorite,
} from './orchestrator/scenes';
import Logger from './logger';

// voice/tts.py exposes a /speak endpoint on this port
const SPEAK_PIPELINE_URL =
    process.env.SPEAK_PIPELINE_URL ?? 'http://localhost:3001/speak';

/**
 * Sends text to the voice pipeline's /speak endpoint so cron-triggered
 * responses are spoken aloud. Fails silently if the pipeline is not running.
 */
async function speakViaPipeline(text: string): Promise<void> {
    return new Promise((resolve) => {
        try {
            const body = JSON.stringify({ text });
            const url = new URL(SPEAK_PIPELINE_URL);
            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port || 80,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    res.resume(); // drain response
                    resolve();
                },
            );
            req.on('error', () => resolve()); // pipeline not running — ignore
            req.write(body);
            req.end();
        } catch {
            resolve();
        }
    });
}

async function main() {
    Logger.info('Starting Yui…');

    const servers = buildServerConfigs();
    const orchestrator = new Orchestrator(servers);
    await orchestrator.init();

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
    };

    // Presence manager — detects departure (MAC) and arrival (GPS)
    // Triggers scenes directly — no LLM involved
    let presence: PresenceManager;
    presence = new PresenceManager((id) =>
        runScene(id, deviceHandler, {
            presenceState: presence.getState(),
            notify: (msg) => sendNotification(msg),
            callToolRaw: (t, a) => orchestrator.callToolRaw(t, a ?? {}),
        }),
    );
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
    });

    const locationHandler = (lat: number, lng: number, accuracy: number) =>
        presence.handleLocation(lat, lng, accuracy);

    const presenceHandler = () => presence.getState();

    const sources: InputSource[] = [new StdinSource(), new HttpSource()];
    for (const source of sources) {
        await source.start(
            handler,
            streamHandler,
            statusHandler,
            deviceHandler,
            scenesHandler,
            toolsHandler,
            locationHandler,
            automationsHandler,
            presenceHandler,
        );
    }

    const shutdown = async (signal: string) => {
        Logger.info(`Received ${signal}, shutting down…`);
        presence.stop();
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
