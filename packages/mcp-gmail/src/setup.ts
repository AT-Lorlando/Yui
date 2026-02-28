// Gmail authorization is handled by the unified Google setup.
// It requests both Calendar and Gmail scopes in a single OAuth flow.
console.log('\nRun the unified Google setup instead:\n');
console.log('  npm run setup:google\n');
console.log('This covers both Google Calendar and Gmail with a single token.');
process.exit(0);
