import { Entity, Light, Speaker, Door } from './Entity';
import { logger } from './logger';
import http from 'http';
import env from './env';
import GPTQueryLauncher from './GPTQueryLauncher';
import SpotifyController from './SpotifyController';

class CommandExecutor {
    entities: Entity[];
    GPTQueryLauncher!: GPTQueryLauncher;
    private spotifyController!: SpotifyController;

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
            logger.error(
                `Error during the initialisation of CommandExecutor: ${error}`,
            );
            throw new Error(
                'Error during the initialisation of CommandExecutor',
            );
        }
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
            logger.error(error.message);
            throw error;
        }
    }

    async backHome(): Promise<void> {
        logger.info('Going back home');
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
                logger.info('Spotify is playing');
                const speaker = (await this.spotifyController.getSpeakerByName(
                    'Les enceintes',
                )) as any;
                if (speaker === undefined) {
                    throw new Error('Speaker not found');
                }
                await this.spotifyController.transferPlayback(speaker.id);
            }
        } catch (error) {
            logger.error(`Error when back home: ${error}`);
        }
    }

    async leaveHome(): Promise<void> {
        logger.info('Leaving home');
        this.PushNotification('Yui', 'See you soon !');
        try {
            this.lightsTurnOff([4, 5, 12]);
        } catch (error) {
            logger.error(`Error when leaving home: ${error}`);
        }
    }

    public PushNotification(pushTitle: string, pushMessage: string): void {
        const apiKey = env.NOTIFYMYDEVICE_API_KEY;
        if (apiKey !== undefined) {
            http.get(
                `http://www.notifymydevice.com/push?ApiKey=${apiKey}&PushTitle=${pushTitle}&PushText=${pushMessage}`,
                (resp) => {
                    resp.on('end', () => {
                        logger.info('Push notification sent');
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

    lightsTurnOn(entitiesID: number[]): void {
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
                logger.error(error.message);
            }
        }
    }

    lightsTurnOff(entitiesID: number[]): void {
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
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
                logger.error(error.message);
            }
        }
    }
}

export default CommandExecutor;
