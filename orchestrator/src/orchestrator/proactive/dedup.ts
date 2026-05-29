export class Dedup {
    private last = new Map<string, number>();

    isDuplicate(subject: string, now: number, cooldownMs: number): boolean {
        const prev = this.last.get(subject);
        return prev !== undefined && now - prev < cooldownMs;
    }

    record(subject: string, now: number): void {
        this.last.set(subject, now);
    }
}
