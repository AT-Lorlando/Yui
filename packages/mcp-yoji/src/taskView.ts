/**
 * Vue compacte des tâches Yoji pour le LLM (14/10/2026).
 *
 * `GET /todos` renvoie TOUTES les tâches (330 en prod, ≈ 440 Ko avec les
 * descriptions) : relayé tel quel, `list_tasks` faisait déborder la fenêtre
 * de contexte (213 k tokens pour 65 k). Ici : projection sur les champs
 * utiles, tâches ouvertes par défaut, limite, descriptions sur demande.
 */

export type TaskState =
    | 'backlog'
    | 'todo'
    | 'in_progress'
    | 'done'
    | 'canceled';

export const OPEN_STATES: TaskState[] = ['in_progress', 'todo', 'backlog'];
export const DEFAULT_LIMIT = 40;
export const MAX_LIMIT = 100;
const DESCRIPTION_MAX = 400;

export interface TaskView {
    id: string;
    title: string;
    state: string;
    project?: string;
    priority?: string;
    due?: string;
    parentId?: string;
    tags?: string[];
    description?: string;
}

export interface TaskListView {
    total: number;
    shown: number;
    tasks: TaskView[];
    hint?: string;
}

export interface ListFilter {
    state?: string;
    project?: string;
    limit?: number;
    detail?: boolean;
}

const STATE_RANK: Record<string, number> = {
    in_progress: 0,
    todo: 1,
    backlog: 2,
    done: 3,
    canceled: 4,
};

export function toTaskView(t: any, detail = false): TaskView {
    const v: TaskView = {
        id: String(t.id),
        title: String(t.title ?? ''),
        state: String(t.state ?? ''),
    };
    if (t.project) v.project = String(t.project);
    if (t.priority && t.priority !== 'none') v.priority = String(t.priority);
    if (t.due) v.due = String(t.due);
    if (t.parentId) v.parentId = String(t.parentId);
    if (Array.isArray(t.tags) && t.tags.length) v.tags = t.tags.map(String);
    if (detail && typeof t.description === 'string' && t.description.trim()) {
        const d = t.description.trim();
        v.description =
            d.length > DESCRIPTION_MAX ? d.slice(0, DESCRIPTION_MAX) + '…' : d;
    }
    return v;
}

export function listTaskView(
    tasks: any[],
    filter: ListFilter = {},
): TaskListView {
    const states = filter.state ? [filter.state] : OPEN_STATES;
    const matching = tasks.filter(
        (t) =>
            states.includes(t.state) &&
            (!filter.project || t.project === filter.project),
    );
    // Tri stable : en cours, puis à faire, puis backlog ; l'ordre Yoji est conservé à l'intérieur.
    const sorted = matching
        .map((t, i) => ({ t, i }))
        .sort(
            (a, b) =>
                (STATE_RANK[a.t.state] ?? 9) - (STATE_RANK[b.t.state] ?? 9) ||
                a.i - b.i,
        )
        .map(({ t }) => t);
    const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Math.floor(Number(filter.limit) || DEFAULT_LIMIT)),
    );
    const shown = sorted
        .slice(0, limit)
        .map((t) => toTaskView(t, !!filter.detail));
    const view: TaskListView = {
        total: sorted.length,
        shown: shown.length,
        tasks: shown,
    };
    if (sorted.length > shown.length) {
        view.hint = `${
            sorted.length - shown.length
        } tâche(s) non affichée(s) : filtre par state ou project, ou augmente limit (max ${MAX_LIMIT}).`;
    }
    return view;
}
