import PlaywrightController from '../src/PlaywrightController';

describe('PlaywrightController E2E Tests', () => {
    let controller: PlaywrightController;

    beforeAll(async () => {
        controller = new PlaywrightController();
    });

    afterAll(async () => {
        await controller.closeBrowser();
    });

    test('should open the browser', async () => {
        const response = await controller.openBrowser();
        expect(response.status).toBe('success');
        expect(response.message).toBe('Browser opened successfully.');
    });

    test('should navigate to a URL', async () => {
        await controller.openBrowser();
        const response = await controller.goToUrl('https://example.com');
        expect(response.status).toBe('success');
        expect(response.message).toBe('Navigated to: https://example.com');
    });

    test('should get page content', async () => {
        await controller.openBrowser();
        await controller.goToUrl('https://example.com');
        const response = await controller.getPageContent();
        expect(response.status).toBe('success');
        expect(response.message).toBe('Content retrieved successfully.');
        expect(response.content).toBeDefined();
    });

    test('should fill and submit input', async () => {
        const url = 'https://fr.wikipedia.org/';
        await controller.openBrowser();
        await controller.goToUrl(url);
        // Get the input selector by inspecting the page
        const response = await controller.fillAndSubmitInput(
            'input[name="search"]',
            'Paris',
        );
        const url_response = await controller.getCurrentUrl();
        expect(response.status).toBe('success');
        expect(response.message).toBe('Form filled with: Paris');
        expect(url_response.status).toBe('success');
        expect(url_response.content).toBe(url + 'wiki/Paris');
    });

    test('should click on an element', async () => {
        const url = 'https://fr.wikipedia.org/';
        await controller.openBrowser();
        await controller.goToUrl(url + 'wiki/Paris');
        // Get the element selector by inspecting the page
        const response = await controller.clickOnElement(
            'a[href="/wiki/Capitale_de_la_France"]',
        );
        const url_response = await controller.getCurrentUrl();
        expect(response.status).toBe('success');
        expect(response.message).toBe(
            'Clicked on: a[href="/wiki/Capitale_de_la_France"]',
        );
        expect(url_response.status).toBe('success');
        expect(url_response.content).toBe(url + 'wiki/Capitale_de_la_France');
    });

    test('should close the browser', async () => {
        await controller.openBrowser();
        const response = await controller.closeBrowser();
        expect(response.status).toBe('success');
        expect(response.message).toBe('Browser closed successfully.');
    });
});
