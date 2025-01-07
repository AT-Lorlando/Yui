export type Category = 'Router' | 'Domotic' | 'Browser' | 'General';

export type Order = {
    content: string;
    // user ?
    // room ?
};

export type Role = 'system' | 'user' | 'assistant';

export interface Content {
    role: Role;
    content: string;
}

export type StoryContent = Content[];

export interface DomoticCommand {
    name: 'SetEntityState' | 'GetWeather';
    parameters: string;
}

export interface BrowserCommand {
    name: 'OpenBrowser' | 'GoToUrl';
    parameters: string;
}

export interface GeneralCommand {
    name: 'AskUser' | 'Say';
    parameters: string;
}

export type RouterLlmResponse = {
    category: Category;
};

export type DomoticLlmResponse = {
    commands: DomoticCommand[];
};

export type BrowserLlmResponse = {
    commands: BrowserCommand[];
};

export type GeneralLlmResponse = {
    commands: GeneralCommand[];
};

export type LlmResponse =
    | DomoticLlmResponse
    | BrowserLlmResponse
    | GeneralLlmResponse;
