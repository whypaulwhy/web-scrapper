// Vercel serverless entry point: every /api/* request is rewritten here (see vercel.json)
// and handled by the same Express app that runs locally with `npm run dev`.
import app from '../backend/src/app.js';

export default app;
