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
}
