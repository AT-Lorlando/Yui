export type StreamOptions = {
    /** Cap the LLM response length. Use ~80 for voice, undefined for text. */
    maxTokens?: number;
    /** Output channel for automations created during this request. */
    outputChannel?: import('../orchestrator/automations').OutputChannel;
    /** Id d'une conversation app à continuer/reprendre. */
    conversationId?: string;
    /** Force le chemin "app" même sans id (nouvelle conversation app). */
    appConversation?: boolean;
    /** Callback : id de la conversation utilisée (émis en 1er event SSE). */
    onConversationId?: (id: string) => void;
};

/** Un élément du stream : du texte, un événement « outil appelé », ou un
 *  fragment de raisonnement du modèle (jamais parlé, affiché par l'app). */
export type StreamItem =
    | string
    | { tool: string; args?: Record<string, unknown> }
    | { thinking: string };

export type StreamHandler = (
    order: string,
    options?: StreamOptions,
    reset?: boolean,
) => AsyncGenerator<StreamItem, void, unknown>;

export type StatusHandler = () => object;

export type DeviceHandler = (
    toolName: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

export interface ScenesHandler {
    list: () => import('../orchestrator/scenes').Scene[];
    trigger: (id: string) => Promise<{ success: boolean; error?: string }>;
    create: (
        data: import('../orchestrator/scenes').CreateSceneInput,
    ) => import('../orchestrator/scenes').Scene;
    update: (
        id: string,
        input: Partial<import('../orchestrator/scenes').CreateSceneInput>,
    ) => import('../orchestrator/scenes').Scene | null;
    remove: (id: string) => boolean;
    toggleFavorite: (
        id: string,
    ) => import('../orchestrator/scenes').Scene | null;
}

export interface ToolsHandler {
    /** Appel direct avec le drapeau d'erreur du MCP (route /tools/:name). */
    callWithStatus: (
        name: string,
        args: Record<string, unknown>,
    ) => Promise<{ result: unknown; isError: boolean }>;
    list: () => {
        serverName: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        hidden: boolean;
    }[];
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /**
     * Appel sans la garde d'annulation d'animation. Réservé aux aperçus
     * d'animation : leurs propres écritures ne doivent pas s'auto-annuler.
     */
    callRaw?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AutomationsHandler {
    list: () => import('../orchestrator/automations').Automation[];
    add: (
        input: import('../orchestrator/automations').CreateAutomationInput,
    ) => import('../orchestrator/automations').Automation;
    update: (
        id: string,
        patch: Partial<
            Omit<
                import('../orchestrator/automations').Automation,
                'id' | 'createdAt'
            >
        >,
    ) => import('../orchestrator/automations').Automation | null;
    toggle: (id: string) => string | null;
    remove: (id: string) => boolean;
    run: (id: string) => Promise<{ success: boolean; error?: string }>;
}

export interface PresenceConfigDto {
    homeLat: number;
    homeLng: number;
    geofence: { enabled: boolean; radiusM: number };
    mac: { burstIntervalMs: number; burstWindowMs: number };
}

export interface PresenceHandler {
    getState: () => import('../orchestrator/presence').PresenceState;
    handleGeofence: (
        transition: string,
    ) => import('../orchestrator/presence').PresenceState;
    getConfig: () => PresenceConfigDto;
    setConfig: (patch: {
        geofence?: { enabled?: boolean; radiusM?: number };
        mac?: { burstIntervalMs?: number; burstWindowMs?: number };
    }) => PresenceConfigDto;
    listRules: () => import('../orchestrator/presenceRules').PresenceRule[];
    replaceRules: (
        rules: import('../orchestrator/presenceRules').PresenceRule[],
    ) => import('../orchestrator/presenceRules').PresenceRule[];
}

/** Respawns an MCP server to pick up data/integrations.json edits. */
export interface IntegrationsHandler {
    reconnect: (serverName: string) => Promise<boolean>;
}

/** Reloads the proactive engine to apply data/proactive.json edits. */
export interface ProactiveHandler {
    reload: () => void;
    /** Briques (défs + état effectif) pour la page /proactive. */
    bricks?: () => unknown;
    /** Journal des interventions (récval du juge) + feedback 👍/👎. */
    journal?: (limit?: number, before?: number) => unknown;
    /** Réserve : événements retenus ; retrait par `source:key`, sans marquer dit. */
    held?: () => unknown;
    heldRemove?: (key: string) => boolean;
    /** Décision manuelle sur un retenu (`source:key`) ou une entrée de
     *  journal — lève `DecisionNotFound` / `DecisionExpired` (mapping HTTP par
     *  `err.name`) ; rend `{ channel, message }`. */
    decideHeld?: (
        key: string,
        channel: 'speak' | 'notify' | 'skip',
    ) => Promise<unknown>;
    decideJournal?: (
        id: string,
        channel: 'speak' | 'notify' | 'skip',
    ) => Promise<unknown>;
    /** Statut des connecteurs + sources externes (`ConnectorStatusView[]`). */
    connectors?: () => unknown;
    /** Relève manuelle — lève `ConnectorNotFound` / `ConnectorNoEvents` /
     *  `ConnectorBusy` (mapping HTTP par `err.name`). */
    connectorPoll?: (id: string) => Promise<unknown>;
    /** Attentes : `{ watches, orders }` (ordres courrier actifs hors
     *  connecteurs) ; ajout (lève une `Error` de validation → 400) ; retrait
     *  (avec l'ordre courrier lié, false si inconnue). */
    watches?: () => unknown;
    watchAdd?: (input: {
        what: string;
        source?: string;
        keywords: string[];
        days?: number;
        origin: 'voice' | 'app';
    }) => unknown;
    watchRemove?: (id: string) => boolean;
    /** Mémoire « dit » ; oubli par sujet (false si absent) ou total (nombre retiré). */
    said?: () => unknown;
    saidForget?: (subject: string) => boolean;
    saidForgetAll?: () => number;
    feedback?: (id: string, value: 'up' | 'down') => boolean;
    situation?: () => unknown;
    /** Courrier v3 : listes d'expéditeurs, inconnus, ordres de lecture (page /mail). */
    mailSendersFile?: () => unknown;
    mailSendersReplace?: (raw: unknown) => unknown;
    mailSenderKeep?: (input: {
        match: string;
        name: string;
        read?: 'always' | 'never' | 'rules';
        rules?: Array<{ subject: string; read: boolean }>;
        readDefault?: boolean;
    }) => unknown;
    mailSenderSpam?: (match: string) => unknown;
    mailSenderDelete?: (id: string) => boolean;
    /** Rangement rétroactif d'un expéditeur ; lève « introuvable » si l'id est inconnu. */
    mailSenderApply?: (id: string, max?: number) => Promise<unknown>;
    mailUnknown?: () => unknown;
    mailOrders?: () => unknown;
    mailOrderAdd?: (text: string, days: number) => unknown;
    mailOrderDelete?: (id: string) => boolean;
    /** Essai à blanc des listes sur une requête, sans aucune écriture. */
    mailDryRun?: (query?: string, max?: number) => Promise<unknown>;
    /** Journal des décisions de tri (scope `actions` = notifiées). */
    mailJournal?: (limit?: number, scope?: 'actions') => unknown;
    /** Bilan du tri sur les N derniers jours. */
    mailStats?: (days?: number) => unknown;
    /** Scan à la demande de la boîte. */
    mailScan?: () => Promise<unknown>;
    /** Rapport de migration v2 → v3 (null si aucun). */
    mailMigration?: () => unknown;
    /** `POST /events` : le bus reçoit, filtre (péremption/dédup/cooldown) et compte. */
    ingest?: (
        events: import('../orchestrator/proactive/events').Event[],
    ) => Promise<
        Record<import('../orchestrator/proactive/ingest').IngestOutcome, number>
    >;
    /** Point à la demande : texte rendu (marqué dit, journalisé) — `POST /proactive/brief`. */
    brief?: (scope?: string) => Promise<unknown>;
    /** Ce qui sortirait maintenant, sans effet de bord — `GET /proactive/brief/preview`. */
    briefPreview?: (scope?: string) => unknown;
}

export type DashboardHandler = () => Promise<
    import('../orchestrator/dashboard').DashboardData
>;

export interface ConversationsHandler {
    list: (
        scope: 'resumable' | 'all',
    ) => import('../orchestrator/storyArchive').StoryIndexEntry[];
    get: (id: string) => {
        entries: import('../orchestrator/story').StoryEntry[];
        meta?: import('../orchestrator/storyArchive').StoryIndexEntry;
        branches: import('../orchestrator/storyArchive').StoryIndexEntry[];
    };
    simulate: (
        id: string,
        body: {
            fromMessageIndex?: number;
            systemPrompt?: string;
            temperature?: number;
        },
        options: { onConversationId?: (id: string) => void },
    ) => AsyncGenerator<string, void, unknown>;
}

export interface InputSource {
    start(
        handler: (
            order: string,
            reset?: boolean,
            outputChannel?: import('../orchestrator/automations').OutputChannel,
            conversationId?: string,
        ) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
        automationsHandler?: AutomationsHandler,
        presenceHandler?: PresenceHandler,
        conversationsHandler?: ConversationsHandler,
        integrationsHandler?: IntegrationsHandler,
        proactiveHandler?: ProactiveHandler,
        dashboardHandler?: DashboardHandler,
    ): Promise<void>;
    stop(): Promise<void>;
}
