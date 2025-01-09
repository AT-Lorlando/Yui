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

export interface parameters {
    entity: string;
    stateChanges: stateChange[];
    text?: string;
}

export type StoryContent = Content[];

export interface DomoticCommand {
    name: 'SetEntityState' | 'GetWeather';
    parameters: parameters;
}

export interface BrowserCommand {
    name: 'OpenBrowser' | 'GoToUrl';
    parameters: parameters;
}

export interface GeneralCommand {
    name: 'AskUser' | 'Say';
    parameters: parameters;
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

export type stateChange = {
    property: string;
    value: string;
};
