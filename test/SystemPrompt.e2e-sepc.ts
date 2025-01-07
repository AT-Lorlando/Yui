jest.mock('../src/Controller/HueController');
jest.mock('../src/Controller/SpotifyController');

import Orchestrator from '../src/Service/Orchestrator';
import { Order } from '../src/types/types';

describe('Orchestrator', () => {
    let orchestrator: Orchestrator;

    beforeEach(() => {
        orchestrator = new Orchestrator();
    });

    test('aNewStoryBegin should create a new story', async () => {
        const order: Order = {
            content: 'Allume la lumière du salon',
        };
        const story = await orchestrator.aNewStoryBegin(order);

        expect(story).toBeDefined();
        expect(story.category).toBe('light');
        expect(story.content).toBe('Allume la lumière du salon');
    });
});
