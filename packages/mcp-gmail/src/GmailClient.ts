import { google } from 'googleapis';
import type { Auth, gmail_v1 } from 'googleapis';
import Logger from './logger';

const TIMEZONE = 'Europe/Paris';

export class GmailClient {
    private gmail: gmail_v1.Gmail;

    constructor(auth: Auth.OAuth2Client) {
        this.gmail = google.gmail({ version: 'v1', auth });
    }

    // ── Formatting helpers ────────────────────────────────────────────────────

    private formatDate(isoOrDate: string | null | undefined): string {
        if (!isoOrDate) return 'Date inconnue';
        const d = new Date(isoOrDate);
        if (isNaN(d.getTime())) return isoOrDate;
        return d.toLocaleString('fr-FR', {
            timeZone: TIMEZONE,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    private relativeDate(dateMs: number): string {
        const now = Date.now();
        const diff = now - dateMs;
        const minutes = Math.floor(diff / 60_000);
        const hours = Math.floor(diff / 3_600_000);
        const days = Math.floor(diff / 86_400_000);
        if (minutes < 1) return 'a l\'instant';
        if (minutes < 60) return `il y a ${minutes} min`;
        if (hours < 24) return `il y a ${hours}h`;
        if (days === 1) return 'hier';
        if (days < 7) return `il y a ${days} jours`;
        return this.formatDate(new Date(dateMs).toISOString());
    }

    /** Decode base64url-encoded Gmail payload body recursively. */
    private decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
        if (!payload) return '';

        // Prefer text/plain, fall back to text/html (stripped)
        if (payload.mimeType === 'text/plain' && payload.body?.data) {
            return Buffer.from(payload.body.data, 'base64').toString('utf-8');
        }

        if (payload.mimeType === 'text/html' && payload.body?.data) {
            const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
            // Strip HTML tags for clean text
            return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        // Multipart — recurse into parts, prefer text/plain part
        if (payload.parts) {
            const plainPart = payload.parts.find((p) => p.mimeType === 'text/plain');
            if (plainPart) return this.decodeBody(plainPart);

            // Fall back to first non-attachment part
            for (const part of payload.parts) {
                if (part.mimeType?.startsWith('multipart/')) {
                    const nested = this.decodeBody(part);
                    if (nested) return nested;
                }
            }
            const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
            if (htmlPart) return this.decodeBody(htmlPart);
        }

        return '';
    }

    private header(msg: gmail_v1.Schema$Message, name: string): string {
        return (
            msg.payload?.headers?.find(
                (h) => h.name?.toLowerCase() === name.toLowerCase(),
            )?.value ?? ''
        );
    }

    private buildRaw(
        to: string,
        subject: string,
        body: string,
        options: {
            cc?: string;
            inReplyTo?: string;
            references?: string;
            from?: string;
        } = {},
    ): string {
        const lines: string[] = [];
        if (options.from) lines.push(`From: ${options.from}`);
        lines.push(`To: ${to}`);
        if (options.cc) lines.push(`Cc: ${options.cc}`);
        lines.push(`Subject: ${subject}`);
        if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
        if (options.references) lines.push(`References: ${options.references}`);
        lines.push('Content-Type: text/plain; charset=utf-8');
        lines.push('MIME-Version: 1.0');
        lines.push('');
        lines.push(body);
        return Buffer.from(lines.join('\r\n')).toString('base64url');
    }

    private formatMessageSummary(msg: gmail_v1.Schema$Message): string {
        const from = this.header(msg, 'From');
        const subject = this.header(msg, 'Subject') || '(sans objet)';
        const date = parseInt(msg.internalDate ?? '0');
        const isUnread = msg.labelIds?.includes('UNREAD') ?? false;
        const snippet = msg.snippet ?? '';
        return [
            `ID: ${msg.id}`,
            `De: ${from}`,
            `Objet: ${subject}`,
            `Date: ${this.relativeDate(date)}`,
            `Lu: ${isUnread ? 'Non' : 'Oui'}`,
            snippet ? `Apercu: ${snippet.slice(0, 120)}` : '',
        ]
            .filter(Boolean)
            .join('\n');
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async listEmails(options: {
        maxResults?: number;
        query?: string;
        labelIds?: string[];
    } = {}): Promise<string> {
        const maxResults = Math.min(options.maxResults ?? 20, 50);
        const labelIds = options.labelIds ?? ['INBOX'];

        const listRes = await this.gmail.users.messages.list({
            userId: 'me',
            maxResults,
            labelIds,
            q: options.query,
        });

        const messages = listRes.data.messages ?? [];
        if (messages.length === 0) return 'Aucun email trouvé.';

        // Fetch full metadata for each message in parallel
        const full = await Promise.all(
            messages.map((m) =>
                this.gmail.users.messages.get({
                    userId: 'me',
                    id: m.id!,
                    format: 'metadata',
                    metadataHeaders: ['From', 'Subject', 'Date'],
                }),
            ),
        );

        const lines = full.map((r, i) => `[${i + 1}]\n${this.formatMessageSummary(r.data)}`);
        return `${messages.length} email(s) :\n\n${lines.join('\n\n---\n\n')}`;
    }

    async getEmail(messageId: string): Promise<string> {
        const res = await this.gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const msg = res.data;
        const from = this.header(msg, 'From');
        const to = this.header(msg, 'To');
        const cc = this.header(msg, 'Cc');
        const subject = this.header(msg, 'Subject') || '(sans objet)';
        const date = this.formatDate(
            new Date(parseInt(msg.internalDate ?? '0')).toISOString(),
        );
        const isUnread = msg.labelIds?.includes('UNREAD') ?? false;
        const labels = (msg.labelIds ?? []).join(', ');
        const body = this.decodeBody(msg.payload);

        const parts = [
            `ID: ${msg.id}`,
            `Thread: ${msg.threadId}`,
            `De: ${from}`,
            `A: ${to}`,
            cc ? `Cc: ${cc}` : '',
            `Objet: ${subject}`,
            `Date: ${date}`,
            `Lu: ${isUnread ? 'Non' : 'Oui'}`,
            `Labels: ${labels}`,
            '',
            '--- Corps ---',
            body || '(corps vide)',
        ];

        return parts.filter((l) => l !== '').join('\n');
    }

    async searchEmails(query: string, maxResults = 20): Promise<string> {
        const listRes = await this.gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: Math.min(maxResults, 50),
        });

        const messages = listRes.data.messages ?? [];
        if (messages.length === 0) return `Aucun email pour la recherche : "${query}"`;

        const full = await Promise.all(
            messages.map((m) =>
                this.gmail.users.messages.get({
                    userId: 'me',
                    id: m.id!,
                    format: 'metadata',
                    metadataHeaders: ['From', 'Subject', 'Date'],
                }),
            ),
        );

        const lines = full.map((r, i) => `[${i + 1}]\n${this.formatMessageSummary(r.data)}`);
        return `${messages.length} résultat(s) pour "${query}" :\n\n${lines.join('\n\n---\n\n')}`;
    }

    async sendEmail(
        to: string,
        subject: string,
        body: string,
        cc?: string,
    ): Promise<string> {
        const raw = this.buildRaw(to, subject, body, { cc });
        await this.gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw },
        });
        Logger.info(`Email sent to ${to}: "${subject}"`);
        return `Email envoyé à ${to} — objet : "${subject}"`;
    }

    async replyEmail(messageId: string, body: string): Promise<string> {
        // Fetch the original to get thread ID, subject and sender
        const orig = await this.gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Message-ID'],
        });

        const from = this.header(orig.data, 'From');
        const subject = this.header(orig.data, 'Subject');
        const originalMessageId = this.header(orig.data, 'Message-ID');
        const threadId = orig.data.threadId!;
        const replySubject = subject.startsWith('Re: ') ? subject : `Re: ${subject}`;

        const raw = this.buildRaw(from, replySubject, body, {
            inReplyTo: originalMessageId,
            references: originalMessageId,
        });

        await this.gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw, threadId },
        });

        Logger.info(`Reply sent to ${from} on thread ${threadId}`);
        return `Réponse envoyée à ${from} — objet : "${replySubject}"`;
    }

    async createDraft(to: string, subject: string, body: string): Promise<string> {
        const raw = this.buildRaw(to, subject, body);
        const res = await this.gmail.users.drafts.create({
            userId: 'me',
            requestBody: { message: { raw } },
        });
        Logger.info(`Draft created: ${res.data.id}`);
        return `Brouillon créé (ID: ${res.data.id}) — objet : "${subject}"`;
    }

    async trashEmail(messageId: string): Promise<string> {
        await this.gmail.users.messages.trash({ userId: 'me', id: messageId });
        Logger.info(`Email ${messageId} moved to trash`);
        return `Email ${messageId} déplacé dans la corbeille.`;
    }

    async archiveEmail(messageId: string): Promise<string> {
        await this.gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: { removeLabelIds: ['INBOX'] },
        });
        Logger.info(`Email ${messageId} archived`);
        return `Email ${messageId} archivé.`;
    }

    async markRead(messageId: string): Promise<string> {
        await this.gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: { removeLabelIds: ['UNREAD'] },
        });
        return `Email ${messageId} marqué comme lu.`;
    }

    async markUnread(messageId: string): Promise<string> {
        await this.gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: { addLabelIds: ['UNREAD'] },
        });
        return `Email ${messageId} marqué comme non lu.`;
    }

    async listLabels(): Promise<string> {
        const res = await this.gmail.users.labels.list({ userId: 'me' });
        const labels = res.data.labels ?? [];

        const system = labels.filter((l) => l.type === 'system');
        const user = labels.filter((l) => l.type === 'user');

        const fmt = (l: gmail_v1.Schema$Label) =>
            `  ${l.name} (ID: ${l.id})${l.messagesUnread ? ` — ${l.messagesUnread} non lu(s)` : ''}`;

        const lines = [
            'Labels système :',
            ...system.map(fmt),
            '',
            'Labels personnalisés :',
            ...user.map(fmt),
        ];

        return lines.join('\n');
    }
}
