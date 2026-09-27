export type FetchFn = typeof fetch;

export type TaskState =
    | 'backlog'
    | 'todo'
    | 'in_progress'
    | 'done'
    | 'canceled';

export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface YojiClientOptions {
    baseUrl: string;
    apiKey?: string;
    fetchFn?: FetchFn;
}

export interface CreateTaskInput {
    title: string;
    state?: TaskState;
    project?: string | null;
    parent?: string;
    description?: string;
    priority?: TaskPriority;
    tags?: string[];
}

export interface Postit {
    id: string;
    title: string;
    state: TaskState;
    tags: string[];
    createdAt: string;
    ageDays: number;
}

export interface CreatePostitInput {
    title: string;
    description?: string;
    tags?: string[];
}

/** Jours pleins écoulés depuis createdAt ; 0 si absent/invalide (jamais négatif). */
function ageDaysFrom(createdAt: unknown, now: Date): number {
    if (typeof createdAt !== 'string') return 0;
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return 0;
    return Math.max(
        0,
        Math.floor((now.getTime() - created.getTime()) / 86400000),
    );
}

/** Déduplique et nettoie les tags avant envoi : un doublon fait 422 côté Yoji. */
function dedupeTags(tags?: string[]): string[] {
    if (!tags) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of tags) {
        const t = raw.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        result.push(t);
    }
    return result;
}

export interface UpdateTaskInput {
    title?: string;
    state?: TaskState;
    description?: string;
    priority?: TaskPriority;
}

export class YojiClient {
    private baseUrl: string;
    private apiKey?: string;
    private fetchFn: FetchFn;

    constructor(opts: YojiClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.apiKey = opts.apiKey;
        this.fetchFn = opts.fetchFn ?? fetch;
    }

    /** URL-encode a repo-relative path segment by segment, encoding slashes too. */
    encodePath(p: string): string {
        return p.split('/').map(encodeURIComponent).join('%2F');
    }

    protected async request<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            let detail = '';
            try {
                const data = (await res.json()) as any;
                detail = data?.message || data?.error || '';
            } catch {
                /* no JSON body */
            }
            throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }

        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }

    // ── Notes ────────────────────────────────────────────────────────────────
    listNotes(): Promise<any[]> {
        return this.request('GET', '/notes');
    }
    getNote(path: string): Promise<any> {
        return this.request('GET', `/notes/${this.encodePath(path)}`);
    }
    createNote(path: string, content: string): Promise<any> {
        return this.request('POST', '/notes', { path, content });
    }
    updateNote(path: string, content: string): Promise<any> {
        return this.request('PUT', `/notes/${this.encodePath(path)}`, {
            content,
        });
    }
    deleteNote(path: string): Promise<void> {
        return this.request('DELETE', `/notes/${this.encodePath(path)}`);
    }
    moveNote(from: string, to: string): Promise<any> {
        return this.request('POST', '/notes/move', { from, to });
    }
    searchNotes(query: string): Promise<any[]> {
        return this.request('GET', `/search?q=${encodeURIComponent(query)}`);
    }
    listFolders(): Promise<string[]> {
        return this.request('GET', '/folders');
    }
    createFolder(path: string): Promise<any> {
        return this.request('POST', '/folders', { path });
    }
    syncVault(): Promise<any> {
        return this.request('POST', '/sync');
    }

    // ── Todos & projects ───────────────────────────────────────────────────────
    async listTasks(filter?: {
        state?: TaskState;
        project?: string;
    }): Promise<any[]> {
        const tasks = await this.request<any[]>('GET', '/todos');
        return tasks.filter(
            (t) =>
                (!filter?.state || t.state === filter.state) &&
                (!filter?.project || t.project === filter.project),
        );
    }
    createTask(input: CreateTaskInput): Promise<any> {
        return this.request('POST', '/todos', input);
    }
    updateTask(id: string, input: UpdateTaskInput): Promise<any> {
        return this.request('PUT', `/todos/${encodeURIComponent(id)}`, input);
    }
    deleteTask(id: string): Promise<void> {
        return this.request('DELETE', `/todos/${encodeURIComponent(id)}`);
    }
    listProjects(): Promise<any[]> {
        return this.request('GET', '/todos/projects');
    }
    createProject(name: string, description?: string): Promise<any> {
        return this.request('POST', '/todos/projects', { name, description });
    }
    deleteProject(path: string): Promise<void> {
        return this.request(
            'DELETE',
            `/todos/projects/${this.encodePath(path)}`,
        );
    }

    // ── Post-its ────────────────────────────────────────────────────────────────
    // Un post-it est une tâche sans projet ni parent (isPostIt côté frontend Yoji).
    async listPostits(now: Date = new Date()): Promise<Postit[]> {
        const tasks = await this.request<any[]>('GET', '/todos');
        return tasks
            .filter(
                (t) =>
                    !t.project &&
                    !t.parentId &&
                    (t.state === 'todo' || t.state === 'backlog'),
            )
            .map((t) => ({
                id: t.id,
                title: t.title,
                state: t.state,
                tags: Array.isArray(t.tags) ? t.tags : [],
                createdAt: t.createdAt,
                ageDays: ageDaysFrom(t.createdAt, now),
            }));
    }

    createPostit(input: CreatePostitInput): Promise<any> {
        return this.request('POST', '/todos', {
            title: input.title,
            description: input.description,
            state: 'todo',
            project: null,
            tags: dedupeTags(input.tags),
        });
    }
}
