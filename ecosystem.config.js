module.exports = {
    apps: [
      {
        name: 'Yui',
        script: 'npx ts-node src/main.ts',
        env: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
        },
      },
    ],
  };
  