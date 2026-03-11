import Logger from '../logger';

/**
 * Send a push notification with the given text.
 * Currently a stub — hook up ntfy/Pushover/mobile app here.
 */
export async function sendNotification(text: string): Promise<void> {
    // TODO: connect to ntfy / Pushover / mobile app
    Logger.info(`[notify] ${text}`);
}
