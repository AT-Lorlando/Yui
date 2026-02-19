import * as fs from 'fs';
import * as path from 'path';
import type { BaseEntity, EntitySnapshot } from './entities';
import Logger from './logger';

export class EntityStore<T extends BaseEntity & { state: Record<string, any> }> {
    private cache = new Map<string | number, T>();
    private serverName: string;
    private snapshotDir: string;

    constructor(serverName: string, baseDir?: string) {
        this.serverName = serverName;
        this.snapshotDir = path.resolve(baseDir ?? process.cwd(), '.entities');
    }

    setAll(entities: T[]): void {
        this.cache.clear();
        for (const entity of entities) {
            this.cache.set(entity.id, entity);
        }
    }

    getAll(): T[] {
        return Array.from(this.cache.values());
    }

    getById(id: string | number): T | undefined {
        return this.cache.get(id);
    }

    updateState(id: string | number, partial: Partial<T['state']>): void {
        const entity = this.cache.get(id);
        if (entity) {
            entity.state = { ...entity.state, ...partial };
        }
    }

    loadSnapshot(): void {
        try {
            const filePath = path.join(
                this.snapshotDir,
                `${this.serverName}.json`,
            );
            if (!fs.existsSync(filePath)) {
                Logger.debug(`No snapshot found at ${filePath}`);
                return;
            }
            const raw = fs.readFileSync(filePath, 'utf-8');
            const snapshot: EntitySnapshot<T> = JSON.parse(raw);
            this.setAll(snapshot.entities);
            Logger.debug(
                `Loaded ${snapshot.entityCount} entities from snapshot ${filePath}`,
            );
        } catch (error) {
            Logger.warn(`Failed to load entity snapshot: ${error}`);
        }
    }

    saveSnapshot(): void {
        try {
            if (!fs.existsSync(this.snapshotDir)) {
                fs.mkdirSync(this.snapshotDir, { recursive: true });
            }
            const snapshot: EntitySnapshot<T> = {
                serverName: this.serverName,
                discoveredAt: new Date().toISOString(),
                entityCount: this.cache.size,
                entities: this.getAll(),
            };
            const filePath = path.join(
                this.snapshotDir,
                `${this.serverName}.json`,
            );
            fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
            Logger.debug(`Entity snapshot saved to ${filePath}`);
        } catch (error) {
            Logger.error(`Failed to save entity snapshot: ${error}`);
        }
    }
}
