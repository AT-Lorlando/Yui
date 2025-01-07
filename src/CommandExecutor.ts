import Entity from './Entity/Entity';
import { Light } from './Entity/Light';
import { Speaker } from './Entity/Speaker';
import { Door } from './Entity/Door';
import Logger from './Logger';
import http from 'http';
import env from './env';
import GPTQueryLauncher from './Service/GPTQueryLauncher';
import SpotifyController from './Controller/SpotifyController';

class CommandExecutor {
    entities: Entity[];
    GPTQueryLauncher!: GPTQueryLauncher;
    private spotifyController!: SpotifyController;
    private timedEvents: { time: number; callback: () => void }[] = [];

    constructor() {
        this.entities = [];
    }

    async init(
        entities: Entity[],
        spotifyController: SpotifyController,
        GPTQueryLauncher: GPTQueryLauncher,
    ): Promise<void> {
        try {
            this.entities = entities;
            this.GPTQueryLauncher = GPTQueryLauncher;
            this.spotifyController = spotifyController;
        } catch (error) {
            Logger.error(
                `Error during the initialisation of CommandExecutor: ${error}`,
            );
            throw new Error(
                'Error during the initialisation of CommandExecutor',
            );
        }

        setInterval(() => this.timedCycle(), 1000);
    }

    private getEntity(entityID: number): Entity {
        const entity = this.entities.find((entity) => entity.id === entityID);
        if (entity === undefined) {
            throw new Error(`Entity with id ${entityID} not found`);
        }
        return entity;
    }

    async spotifyAuth(code: string): Promise<void> {
        if (this.spotifyController === undefined) {
            throw new Error('SpotifyController is undefined');
        }
        this.spotifyController
            .exchangeAuthorizationCode(code)
            .then(({ accessToken, refreshToken }) => {
                if (this.spotifyController === undefined) {
                    throw new Error('SpotifyController is undefined');
                }
                this.spotifyController.saveRefreshToken(refreshToken);
                this.spotifyController.setAccessToken(accessToken);
            });
    }

    getEntities(): { name: string; id: number; room: string; type: string }[] {
        return this.entities.map((entity) => {
            const { name, id, room } = entity;
            const type = entity.constructor.name;
            return { name, id, room, type };
        });
    }

    test(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.test();
        } catch (error: any) {
            Logger.error(error.message);
            throw error;
        }
    }

    async backHome(): Promise<void> {
        Logger.info('Going back home');
        this.PushNotification('Yui', 'Welcome back home !');
        try {
            const lights = [4, 5, 12];
            for (const lightID of lights) {
                const light = this.getEntity(lightID) as Light;
                await light.turnon();
                await light.set_luminosity(100);
            }
            if (this.spotifyController === undefined) {
                throw new Error('SpotifyController is undefined');
            }
            if (await this.spotifyController.isPlaying()) {
                Logger.info('Spotify is playing');
                const speaker = (await this.spotifyController.getSpeakerByName(
                    'Les enceintes',
                )) as any;
                if (speaker === undefined) {
                    throw new Error('Speaker not found');
                }
                await this.spotifyController.transferPlayback(speaker.id);
            }
        } catch (error) {
            Logger.error(`Error when back home: ${error}`);
        }
    }

    async leaveHome(): Promise<void> {
        Logger.info('Leaving home');
        this.PushNotification('Yui', 'See you soon !');
        try {
            this.lightsTurnOff([4, 5, 12]);
        } catch (error) {
            Logger.error(`Error when leaving home: ${error}`);
        }
    }

    public PushNotification(pushTitle: string, pushMessage: string): void {
        const apiKey = env.NOTIFYMYDEVICE_API_KEY;
        if (apiKey !== undefined) {
            http.get(
                `http://www.notifymydevice.com/push?ApiKey=${apiKey}&PushTitle=${pushTitle}&PushText=${pushMessage}`,
                (resp) => {
                    resp.on('end', () => {
                        Logger.info('Push notification sent');
                    });
                },
            );
        }
    }

    public evalCommandFromOrder(command: string): void {
        if (this.GPTQueryLauncher == undefined) {
            throw new Error('GPT3Request is not initialized');
        }
        this.GPTQueryLauncher.evalCommandFromOrder(command);
    }

    private timedCycle(): void {
        const now = Date.now();
        Logger.silly(`Timed cycle at ${now}`);
        Logger.silly(`Timed events: ${this.timedEvents.length}`);
        for (const event of this.timedEvents) {
            Logger.silly(`Event at ${event.time}`);
            if (now >= event.time) {
                Logger.silly('Event triggered');
                try {
                    event.callback();
                    this.timedEvents.splice(this.timedEvents.indexOf(event), 1);
                } catch (error: any) {
                    Logger.error(error.message);
                }
            }
        }
    }

    addTimedEvent(
        time: number,
        callback: (...args: any[]) => void,
        ...args: any[]
    ): void {
        const now = Date.now();
        console.log(now);
        console.log(time);
        Logger.silly(`Adding timed event at ${now + time}`);
        this.timedEvents.push({
            time: now + time,
            callback: () => callback(...args),
        });
    }

    getTimestamp(): number {
        return Date.now();
    }

    lightsTurnOn(entitiesID: number[]): void {
        Logger.info(`Turning on lights ${entitiesID}`);
        for (const entityID of entitiesID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Light) {
                    entity.turnon();
                } else {
                    throw new Error(
                        `Entity with id ${entityID} is not a light`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    lightsTurnOff(entitiesID: number[]): void {
        Logger.info(`Turning off lights ${entitiesID}`);
        for (const entityID of entitiesID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Light) {
                    entity.turnoff();
                } else {
                    throw new Error(
                        `Entity with id ${entityID} is not a light`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    lightsSetLuminosity(entitiesID: number[], luminosity: number): void {
        for (const entityID of entitiesID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Light) {
                    entity.set_luminosity(luminosity);
                } else {
                    throw new Error(
                        `Entity with id ${entityID} is not a light`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    lightsSetColor(entitiesID: number[], color: string): void {
        for (const entityID of entitiesID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Light) {
                    entity.set_color(color);
                } else {
                    throw new Error(
                        `Entity with id ${entityID} is not a light`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    speakersPlay(speakersID: number[], url: string): void {
        for (const speakerID of speakersID) {
            try {
                const entity = this.getEntity(speakerID);
                if (entity instanceof Speaker) {
                    entity.play(url);
                } else {
                    throw new Error(
                        `Entity with id ${speakerID} is not a speaker`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    speakersStop(): void {
        for (const entity of this.entities) {
            try {
                if (entity instanceof Speaker) {
                    entity.stop();
                } else {
                    throw new Error(
                        `Entity with id ${entity.id} is not a speaker`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    speakersRaiseVolume(): void {
        for (const entity of this.entities) {
            try {
                if (entity instanceof Speaker) {
                    entity.raise_volume();
                } else {
                    throw new Error(
                        `Entity with id ${entity.id} is not a speaker`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    speakersLowerVolume(): void {
        for (const entity of this.entities) {
            try {
                if (entity instanceof Speaker) {
                    entity.lower_volume();
                } else {
                    throw new Error(
                        `Entity with id ${entity.id} is not a speaker`,
                    );
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    doorsUnlock(doorsID: number[]): void {
        for (const entityID of doorsID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Door) {
                    entity.unlock();
                } else {
                    throw new Error(`Entity with id ${entityID} is not a door`);
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }

    doorsLock(doorsID: number[]): void {
        for (const entityID of doorsID) {
            try {
                const entity = this.getEntity(entityID);
                if (entity instanceof Door) {
                    entity.lock();
                } else {
                    throw new Error(`Entity with id ${entityID} is not a door`);
                }
            } catch (error: any) {
                Logger.error(error.message);
            }
        }
    }
}

export default CommandExecutor;
