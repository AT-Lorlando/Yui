declare module 'castv2-client' {
    import { EventEmitter } from 'events';

    export class Client extends EventEmitter {
        connect(host: string, callback: () => void): void;
        launch(app: any, callback: (err: Error | null, player: any) => void): void;
        close(): void;
    }

    export class DefaultMediaReceiver extends EventEmitter {
        static APP_ID: string;
    }
}
