import type { AutomationHistoryEntry } from '../history';

export interface GuardInput {
    tag: string;
    now: number;
    windowMs: number;
    history: AutomationHistoryEntry[];
    enabledAutomationTags: string[];
}

export function isActionBlocked(input: GuardInput): boolean {
    const { tag, now, windowMs, history, enabledAutomationTags } = input;
    if (enabledAutomationTags.includes(tag)) return true;
    return history.some((e) => e.tag === tag && now - e.firedAt < windowMs);
}
