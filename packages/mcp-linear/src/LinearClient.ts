import { LinearClient as SDKClient } from '@linear/sdk';
import Logger from './logger';

const TEAM_NAME = 'Koya';
const TEAM_ID = '61c875b4-a290-4f36-a40a-95e04d38e6fc';

// State name → ID map (cached at startup)
const STATE_IDS: Record<string, string> = {
    backlog: '391db9a9-ea8b-4b22-b078-d750914aaee2',
    todo: 'a0095486-e033-4a62-8284-d1d82364db63',
    'in progress': 'be5540c2-c927-45ee-aa0f-673f8a52a17c',
    done: '6bfbd681-d97b-42ac-919b-c7d9f676f6b9',
    canceled: '9a3629d1-51b0-42b0-83de-3cc2c7f4ceab',
};

export class LinearClient {
    private client: SDKClient;

    constructor(apiKey: string) {
        this.client = new SDKClient({ apiKey });
    }

    private resolveStateId(status: string): string | undefined {
        const key = status.toLowerCase().trim();
        return STATE_IDS[key];
    }

    /** List issues for the Koya team, optionally filtered by status */
    async listIssues(options: {
        status?: string;
        projectId?: string;
        limit?: number;
    } = {}): Promise<any[]> {
        const filter: any = { team: { id: { eq: TEAM_ID } } };
        if (options.status) {
            const stateId = this.resolveStateId(options.status);
            if (stateId) filter.state = { id: { eq: stateId } };
        }
        if (options.projectId) {
            filter.project = { id: { eq: options.projectId } };
        }

        const issues = await this.client.issues({
            filter,
            first: options.limit ?? 50,
            orderBy: 'updatedAt' as any,
        });

        return Promise.all(
            issues.nodes.map(async (i) => ({
                id: i.id,
                identifier: i.identifier,
                title: i.title,
                status: (await i.state)?.name,
                project: (await i.project)?.name,
                url: i.url,
            })),
        );
    }

    /** Get a single issue by ID or identifier (e.g. KOY-42) */
    async getIssue(idOrIdentifier: string): Promise<any> {
        let issue;
        if (idOrIdentifier.toUpperCase().startsWith('KOY-')) {
            const issues = await this.client.issues({
                filter: { number: { eq: parseInt(idOrIdentifier.split('-')[1]) } as any },
                first: 1,
            });
            issue = issues.nodes[0];
        } else {
            issue = await this.client.issue(idOrIdentifier);
        }
        if (!issue) throw new Error(`Issue "${idOrIdentifier}" not found`);

        const [state, project, comments] = await Promise.all([
            issue.state,
            issue.project,
            issue.comments(),
        ]);

        return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            status: state?.name,
            project: project?.name,
            url: issue.url,
            comments: await Promise.all(
                comments.nodes.map(async (c) => ({
                    body: c.body,
                    author: (await c.user)?.name,
                    createdAt: c.createdAt,
                })),
            ),
        };
    }

    /** Create a new issue in the Koya team */
    async createIssue(options: {
        title: string;
        description?: string;
        status?: string;
        projectId?: string;
    }): Promise<any> {
        const payload: any = {
            teamId: TEAM_ID,
            title: options.title,
        };
        if (options.description) payload.description = options.description;
        if (options.status) {
            const stateId = this.resolveStateId(options.status);
            if (stateId) payload.stateId = stateId;
        }
        if (options.projectId) payload.projectId = options.projectId;

        const result = await this.client.createIssue(payload);
        const issue = await result.issue;
        if (!issue) throw new Error('Failed to create issue');
        const state = await issue.state;
        Logger.info(`Created issue ${issue.identifier}: ${issue.title}`);
        return { id: issue.id, identifier: issue.identifier, title: issue.title, status: state?.name, url: issue.url };
    }

    /** Update an issue's title, description, or status */
    async updateIssue(idOrIdentifier: string, options: {
        title?: string;
        description?: string;
        status?: string;
    }): Promise<any> {
        const issue = await this.resolveIssue(idOrIdentifier);
        const payload: any = {};
        if (options.title) payload.title = options.title;
        if (options.description !== undefined) payload.description = options.description;
        if (options.status) {
            const stateId = this.resolveStateId(options.status);
            if (!stateId) throw new Error(`Unknown status "${options.status}". Use: ${Object.keys(STATE_IDS).join(', ')}`);
            payload.stateId = stateId;
        }

        await this.client.updateIssue(issue.id, payload);
        Logger.info(`Updated issue ${issue.identifier}`);
        return { id: issue.id, identifier: issue.identifier, updated: Object.keys(payload) };
    }

    /** Add a comment to an issue */
    async addComment(idOrIdentifier: string, body: string): Promise<any> {
        const issue = await this.resolveIssue(idOrIdentifier);
        const result = await this.client.createComment({ issueId: issue.id, body });
        const comment = await result.comment;
        Logger.info(`Added comment to ${issue.identifier}`);
        return { issueId: issue.id, identifier: issue.identifier, commentId: comment?.id };
    }

    /** List all projects in the Koya team */
    async listProjects(): Promise<any[]> {
        const team = await this.client.team(TEAM_ID);
        const projects = await team.projects();
        return Promise.all(
            projects.nodes.map(async (p) => ({
                id: p.id,
                name: p.name,
                state: p.state,
                url: p.url,
            })),
        );
    }

    /** Create a project in the Koya team */
    async createProject(name: string, description?: string): Promise<any> {
        const result = await this.client.createProject({
            name,
            description,
            teamIds: [TEAM_ID],
        });
        const project = await result.project;
        if (!project) throw new Error('Failed to create project');
        Logger.info(`Created project "${project.name}" (${project.id})`);
        return { id: project.id, name: project.name, url: project.url };
    }

    /** Search issues by keyword */
    async searchIssues(query: string, limit = 20): Promise<any[]> {
        const result = await this.client.searchIssues(query, {
            filter: { team: { id: { eq: TEAM_ID } } },
        });
        const nodes = result.nodes.slice(0, limit);
        return Promise.all(
            nodes.map(async (i) => ({
                id: i.id,
                identifier: i.identifier,
                title: i.title,
                status: (await i.state)?.name,
                url: i.url,
            })),
        );
    }

    private async resolveIssue(idOrIdentifier: string): Promise<{ id: string; identifier: string }> {
        if (idOrIdentifier.toUpperCase().startsWith('KOY-')) {
            const issues = await this.client.issues({
                filter: { number: { eq: parseInt(idOrIdentifier.split('-')[1]) } as any },
                first: 1,
            });
            const issue = issues.nodes[0];
            if (!issue) throw new Error(`Issue "${idOrIdentifier}" not found`);
            return { id: issue.id, identifier: issue.identifier };
        }
        return { id: idOrIdentifier, identifier: idOrIdentifier };
    }

    get teamName() { return TEAM_NAME; }
}
