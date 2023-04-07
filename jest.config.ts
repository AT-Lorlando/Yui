module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/*.*spec.ts'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
    },
    projects: [
        {
            preset: 'ts-jest',
            testEnvironment: 'node',
            displayName: 'unit-integration',
            testMatch: [
                '<rootDir>/test/*.unit-spec.ts',
                '<rootDir>/test/*.int-spec.ts',
            ],
        },
        {
            preset: 'ts-jest',
            testEnvironment: 'node',
            displayName: 'e2e',
            testMatch: ['<rootDir>/test/*.e2e-spec.ts'],
        },
    ],
};
