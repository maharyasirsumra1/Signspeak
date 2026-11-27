import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { createSignSpeakServer } = await import('../server/index.js');
const application = createSignSpeakServer();

application.listen().then(({ address, port }) => {
  console.log(`SignSpeak backend listening at ${process.env.PUBLIC_ORIGIN || `http://${address}:${port}`}`);
}).catch((error) => {
  console.error('Failed to start SignSpeak backend:', error);
  process.exitCode = 1;
});
