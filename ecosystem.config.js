module.exports = {
    apps: [
      {
        name: 'Yui',
        script: 'main.ts',
        interpreter: 'node',
        interpreter_args: '-r ts-node/register/transpile-only',
        env: {
          NODE_ENV: 'production',
        },
      },
    ],
  };
  