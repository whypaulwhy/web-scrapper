import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load backend/.env regardless of the directory the server is started from.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const { default: app } = await import('./app.js');
const { getProviderConfig } = await import('./summarizer.js');

const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  const ai = getProviderConfig();
  console.log(`Backend API running at http://localhost:${port}`);
  console.log(`AI provider: ${ai.label} (${ai.model})`);
  if (!ai.apiKey) {
    console.warn(`WARNING: ${ai.keyEnv} is not set. Copy backend/.env.example to backend/.env and add your key.`);
  }
});
