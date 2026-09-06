// Conversations (liste, détail, simulation SSE) — monté sur /conversations.
import express from 'express';
import type { ConversationsHandler } from '../InputSource';
import type { RequireAuth } from './helpers';

export function conversationRoutes(
    requireAuth: RequireAuth,
    conversationsHandler: ConversationsHandler,
): express.Router {
    const conv = express.Router();
    conv.use(requireAuth);

    conv.get('/', (req: any, res: any) => {
        const scope = req.query?.scope === 'all' ? 'all' : 'resumable';
        res.json(conversationsHandler.list(scope));
    });

    conv.get('/:id', (req: any, res: any) => {
        res.json(conversationsHandler.get(req.params.id));
    });

    conv.post('/:id/simulate', async (req: any, res: any) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        let idSent = false;
        try {
            for await (const token of conversationsHandler.simulate(
                req.params.id,
                {
                    fromMessageIndex: req.body?.fromMessageIndex,
                    systemPrompt: req.body?.systemPrompt,
                    temperature: req.body?.temperature,
                },
                {
                    onConversationId: (id: string) => {
                        if (!idSent) {
                            res.write(
                                `data: ${JSON.stringify({
                                    conversationId: id,
                                })}\n\n`,
                            );
                            idSent = true;
                        }
                    },
                },
            )) {
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
            }
        } catch (error) {
            res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
        } finally {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    return conv;
}
