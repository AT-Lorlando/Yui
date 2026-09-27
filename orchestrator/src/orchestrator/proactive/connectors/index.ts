// Registre des connecteurs — ajouter une source = ajouter un fichier ici.
import type { ConnectorDef, ConnectorServices } from '../connector';
import { weatherConnector } from './weather';
import { presenceConnector } from './presence';
import { calendarConnector } from './calendar';
import { mailConnector } from './mail';
import { deliveriesConnector } from './deliveries';
import { yojiConnector } from './yoji';

export function buildConnectors(services: ConnectorServices): ConnectorDef[] {
    return [
        weatherConnector,
        presenceConnector(services.subscribePresence),
        calendarConnector,
        mailConnector({ concierge: services.concierge }),
        deliveriesConnector(services.complete),
        yojiConnector,
    ];
}
