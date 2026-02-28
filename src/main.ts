import './env'; // load env first
import http from 'http';
import { Orchestrator, buildServerConfigs } from './orchestrator';
import { InputSource, StdinSource, HttpSource } from './input';
import { initScheduler } from './scheduler';
import { listScenes, createScene, deleteScene, runScene } from './scenes';
import Logger from './logger';

// voice_pipeline.py exposes a /speak endpoint on this port
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

    const handler = (order: string, reset?: boolean) =>
        orchestrator.processOrder(order, reset);
    const streamHandler: import('./input/InputSource').StreamHandler = (
        order,
        options,
        reset,
    ) => orchestrator.processOrderStream(order, options, reset);
    const statusHandler = () => orchestrator.getStatus();
    const deviceHandler = (toolName: string, args: Record<string, unknown>) =>
        orchestrator.callTool(toolName, args);

    const scenesHandler = {
        list: listScenes,
        trigger: (id: string) => runScene(id, deviceHandler),
        create: createScene,
        remove: deleteScene,
    };

    const toolsHandler = {
        list: () => orchestrator.getTools(),
        call: (name: string, args: Record<string, unknown>) =>
            orchestrator.callTool(name, args),
    };

    // Scheduler: fires cron jobs, speaks responses via voice pipeline
    initScheduler(handler, speakViaPipeline);

    const sources: InputSource[] = [new StdinSource(), new HttpSource()];
    for (const source of sources) {
        await source.start(
            handler,
            streamHandler,
            statusHandler,
            deviceHandler,
            scenesHandler,
            toolsHandler,
        );
    }

    const shutdown = async (signal: string) => {
        Logger.info(`Received ${signal}, shutting down…`);
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
