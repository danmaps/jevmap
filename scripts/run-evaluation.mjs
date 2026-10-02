// Reuse the project's Vite TypeScript loader, avoiding a second runtime dependency.
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { evaluateDecisions } = await server.ssrLoadModule("/scripts/evaluate-decisions.ts");
  await evaluateDecisions(process.argv.slice(2));
} finally {
  await server.close();
}
