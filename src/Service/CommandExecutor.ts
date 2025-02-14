import Entity from '../Entity/Entity';
import Logger from '../Logger';
import SpotifyController from '../Controller/SpotifyController';

export default class CommandExecutor {
    public entities: Entity[];
    private spotifyController!: SpotifyController;

    constructor() {
        this.entities = [];
    }

    async init(
        entities: Entity[],
        spotifyController: SpotifyController,
    ): Promise<void> {
        try {
            this.entities = entities;
            this.spotifyController = spotifyController;
        } catch (error) {
            Logger.error(
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
            Logger.error(error.message);
            throw error;
        }
    }
}
