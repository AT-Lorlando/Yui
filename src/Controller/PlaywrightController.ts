import { Response } from '../types/response';
import { chromium, Browser, Page } from 'playwright';
import Logger from '../Logger';

export default class PlaywrightController {
    browser: Browser | null;
    page: Page | null;

    constructor() {
        this.browser = null;
        this.page = null;
    }

    async openBrowser(): Promise<Response> {
        if (!this.browser) {
            this.browser = await chromium.launch({ headless: false });
            this.page = await this.browser.newPage();
            Logger.info('Navigateur ouvert.');
            return {
                status: 'success',
                message: 'Browser opened successfully.',
            };
        }
        return { status: 'error', message: 'Browser is already open.' };
    }

    async goToUrl(url: string): Promise<Response> {
        if (this.page) {
            await this.page.goto(url);
            await this.page.waitForTimeout(4000);
            Logger.info(`Navigué vers : ${url}`);
            return { status: 'success', message: `Navigated to: ${url}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async getMainElements(): Promise<Response> {
        if (this.page) {
            const main = await this.page.$('main');
            const mainId = await this.page.$('[id*="main"]');
            const mainClass = await this.page.$('[class*="main"]');
            const mainSlot = await this.page.$('[class*="s-main-slot"]');

            const elements = [main, mainId, mainClass, mainSlot];
            elements.filter((element) => element != null);

            Logger.debug(`Initial elements count: ${elements.length}`);

            const toRemove = new Set<number>();
            await Promise.all(
                elements.map(async (element, index, self) => {
                    await Promise.all(
                        self.map(async (otherElement, otherIndex) => {
                            if (
                                index !== otherIndex &&
                                otherElement &&
                                element
                            ) {
                                const isSameNode = await otherElement.evaluate(
                                    (el, child) => el.isSameNode(child),
                                    element,
                                );
                                if (isSameNode) {
                                    Logger.debug(
                                        `Element at index ${index} is the same as element at index ${otherIndex}`,
                                    );
                                    toRemove.add(Math.max(index, otherIndex));
                                    return;
                                }

                                const contains = await otherElement.evaluate(
                                    (el, child) => el.contains(child),
                                    element,
                                );
                                if (contains) {
                                    Logger.debug(
                                        `Element at index ${index} is a child of element at index ${otherIndex}`,
                                    );
                                    toRemove.add(index);
                                    return;
                                }
                            }
                        }),
                    );
                }),
            );

            const filteredElements = elements.filter(
                (_, index) => !toRemove.has(index),
            );

            // Logger.debug(`Filtered elements count: ${filteredElements.length}`);

            return {
                status: 'success',
                message: 'Main elements retrieved successfully.',
                content: filteredElements,
            };
        }
        return { status: 'error', message: 'Page is not loaded.' };
    }

    async getPageContent(): Promise<Response> {
        return await this.getMainContent();
        // if (this.page) {
        //     const content = await this.page.innerText('body');
        //     const filteredContent = content
        //         .split('\n')
        //         .filter((line: string) => line.trim() !== '')
        //         .join(' ');
        //     return {
        //         status: 'success',
        //         message: 'Content retrieved successfully.',
        //         content: filteredContent,
        //     };
        // }
        // return { status: 'error', message: 'Page is not loaded.' };
    }

    async getMainContent(): Promise<Response> {
        if (this.page) {
            let data = '';
            const mainElements = await this.getMainElements();
            if (mainElements.status === 'error') {
                return mainElements;
            } else if (
                !mainElements.content ||
                mainElements.content.length === 0
            ) {
                return {
                    status: 'error',
                    message: 'No main elements found.',
                };
            }
            for (const element of mainElements.content) {
                if (element) {
                    const content = await element.innerText();
                    const filteredContent = content
                        .split('\n')
                        .filter((line: string) => line.trim() !== '')
                        .join(' ');
                    data += filteredContent;
                }
            }
            return {
                status: 'success',
                message: 'Content retrieved successfully.',
                content: data,
            };
        }
        return { status: 'error', message: 'Page is not loaded.' };
    }

    async getInputsElements(): Promise<Response> {
        if (this.page) {
            const elements = await this.page.$$('input, textarea');

            const visibleInputs = [];
            for (const element of elements) {
                if (await element.isVisible()) {
                    const inputDetails = await element.evaluate((el) => ({
                        tagName: el.tagName,
                        value: (el as HTMLInputElement).value,
                        outerhtml: el.outerHTML,
                    }));
                    visibleInputs.push(
                        `Tag: ${inputDetails.tagName}, Value: ${inputDetails.value}, Outer HTML: ${inputDetails.outerhtml}`,
                    );
                }
            }
            return {
                status: 'success',
                message: 'Inputs retrieved successfully.',
                content: visibleInputs.toString(),
            };
        }
        return { status: 'error', message: 'Page is not loaded.' };
    }

    async getTriggerableElements(): Promise<Response> {
        if (this.page) {
            const elements = await this.page.$$(
                'button, a, input[type="submit"]',
            );
            const triggerableElements = await Promise.all(
                elements.map(async (element) => {
                    const details = await element.evaluate((el) => ({
                        tagName: el.tagName,
                        text:
                            el.childNodes.length > 0
                                ? Array.from(el.childNodes)
                                      .map((node) => node.textContent)
                                      .join('')
                                : '',
                        //outerhtml: el.outerHTML,
                        href: (el as HTMLAnchorElement).href || '',
                    }));
                    return details;
                }),
            );
            return {
                status: 'success',
                message: 'Triggerable elements retrieved successfully.',
                content: triggerableElements,
            };
        }
        return { status: 'error', message: 'Page is not loaded.' };
    }

    async getCurrentUrl(): Promise<Response> {
        if (this.page) {
            const url = this.page.url();
            return {
                status: 'success',
                message: 'URL retrieved successfully.',
                content: url,
            };
        }
        return { status: 'error', message: 'Page is not loaded.' };
    }

    async fillAndSubmitInput(
        selector: string,
        value: string,
    ): Promise<Response> {
        Logger.info(`Remplir le formulaire avec : ${value}`);
        if (this.page) {
            await this.page.fill(selector, value);
            await this.page.waitForTimeout(4000);
            await this.page.press(selector, 'Enter');
            await this.page.waitForTimeout(4000);
            Logger.info(`Formulaire rempli avec : ${value}`);
            return { status: 'success', message: `Form filled with: ${value}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async clickOnElement(selector: string): Promise<Response> {
        if (this.page) {
            await this.page.click(selector);
            await this.page.waitForTimeout(4000);
            Logger.info(`Cliqué sur l'élément : ${selector}`);
            return { status: 'success', message: `Clicked on: ${selector}` };
        }
        return { status: 'error', message: 'Page is not initialized.' };
    }

    async closeBrowser(): Promise<Response> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            Logger.info('Navigateur fermé.');
            return {
                status: 'success',
                message: 'Browser closed successfully.',
            };
        }
        return { status: 'error', message: 'Browser is not open.' };
    }
}
