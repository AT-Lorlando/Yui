module.exports = {
    apps: [
      {
        name: 'Yui',
        script: 'npm run start',
        env: {
          NODE_ENV: 'production',
        },
        autorestart: true,
        watch: true,
      },
    ],
  };
  