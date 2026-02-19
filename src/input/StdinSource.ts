import * as readline from 'readline';
import Logger from '../logger';
import { InputSource } from './InputSource';

export class StdinSource implements InputSource {
    private rl: readline.Interface | null = null;

    async start(handler: (order: string) => Promise<string>): Promise<void> {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false,
        });

        process.stdout.write('Yui ready. Enter your order:\n');

        this.rl.on('line', async (line: string) => {
            const order = line.trim();
            if (!order) return;

            Logger.info(`Received order: "${order}"`);
            try {
                const response = await handler(order);
                process.stdout.write(`\nYui: ${response}\n\n`);
            } catch (error) {
                Logger.error(`Error processing order: ${error}`);
                process.stdout.write(`\nError: ${error}\n\n`);
            }
        });

        this.rl.on('close', () => {
            Logger.info('stdin closed.');
        });
    }

    async stop(): Promise<void> {
        this.rl?.close();
        this.rl = null;
    }
}
