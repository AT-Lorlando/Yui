// Plan des jours = emploi du temps + congés lus dans l'agenda. Point d'entrée
// des réveils et des rappels (chantiers 2 et 4). Ne lève jamais : agenda KO →
// semaine type seule, `calendarOk: false`.

import Logger from '../../logger';
import {
    HORIZON_DAYS,
    fetchAgendaEventsCached,
    type AgendaEvent,
    type CallTool,
} from '../agendaSecretary';
import { addDays, dayPlan, localYmd, type DayPlan } from './dayPlan';
import { readSchedule } from './store';

export async function getDayPlans(
    callTool: CallTool | null,
    from: string,
    days: number,
    now: Date = new Date(),
): Promise<{ plans: DayPlan[]; calendarOk: boolean }> {
    let events: AgendaEvent[] = [];
    let calendarOk = false;
    if (callTool) {
        try {
            events = await fetchAgendaEventsCached(callTool, now);
            calendarOk = true;
        } catch (e) {
            Logger.warn(
                `[schedule] agenda indisponible : ${(e as Error).message}`,
            );
        }
    }
    // L'agenda n'est lu que d'aujourd'hui à +HORIZON_DAYS : hors de cette
    // fenêtre, un congé passerait inaperçu — ne pas prétendre l'avoir vérifié.
    const today = localYmd(now);
    const last = addDays(from, days - 1);
    if (from < today || last > addDays(today, HORIZON_DAYS - 1)) {
        calendarOk = false;
    }
    const schedule = readSchedule(today);
    const plans: DayPlan[] = [];
    for (let i = 0; i < days; i++) {
        plans.push(dayPlan(addDays(from, i), schedule, events));
    }
    return { plans, calendarOk };
}

export async function getDayPlan(
    callTool: CallTool | null,
    date: string,
): Promise<DayPlan> {
    return (await getDayPlans(callTool, date, 1)).plans[0];
}
