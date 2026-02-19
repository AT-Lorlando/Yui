import { chromium, Browser, Page } from 'playwright';
import Logger from './logger';

export interface BrowserResponse {
    status: 'success' | 'error';
    message: string;
    content?: any;
}

export default class PlaywrightController {
    browser: Browser | null;
    page: Page | null;

    constructor() {
        this.browser = null;
        this.page = null;
    }

    async openBrowser(): Promise<BrowserResponse> {
        if (!this.browser) {
            this.browser = await chromium.launch({ headless: false });
            this.page = await this.browser.newPage();
            Logger.info('Browser opened.');
            return {
                status: 'success',
                message: 'Browser opened successfully.',
            };
        }
        return { status: 'error', message: 'Browser is already open.' };
    }

    async goToUrl(url: string): Promise<BrowserResponse> {
        if (this.page) {
            await this.page.goto(url);
            await this.page.waitForTimeout(4000);
            Logger.info(`Navigated to: ${url}`);
            return { status: 'success', message: `Navigated to: ${url}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async getPageContent(): Promise<BrowserResponse> {
        if (!this.page) {
            return { status: 'error', message: 'Page is not loaded.' };
        }
        const content = await this.page.innerText('body');
        const filteredContent = content
            .split('\n')
            .filter((line: string) => line.trim() !== '')
            .join(' ');
        return {
            status: 'success',
            message: 'Content retrieved successfully.',
            content: filteredContent,
        };
    }

    async clickOnElement(selector: string): Promise<BrowserResponse> {
        if (this.page) {
            await this.page.click(selector);
            await this.page.waitForTimeout(2000);
            Logger.info(`Clicked on element: ${selector}`);
            return { status: 'success', message: `Clicked on: ${selector}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async fillAndSubmitInput(
        selector: string,
        value: string,
    ): Promise<BrowserResponse> {
        if (this.page) {
            await this.page.fill(selector, value);
            await this.page.waitForTimeout(2000);
            await this.page.press(selector, 'Enter');
            await this.page.waitForTimeout(2000);
            Logger.info(`Form filled with: ${value}`);
            return { status: 'success', message: `Form filled with: ${value}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async closeBrowser(): Promise<BrowserResponse> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            Logger.info('Browser closed.');
            return {
                status: 'success',
                message: 'Browser closed successfully.',
            };
        }
        return { status: 'error', message: 'Browser is not open.' };
    }
}
