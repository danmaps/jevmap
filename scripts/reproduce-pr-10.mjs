import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { reproduceReview } = await server.ssrLoadModule("/scripts/reproduce-pr-10.ts");
  await reproduceReview(process.argv[2] ?? "docs/review/pr-10-workflows-after.json");
} finally { await server.close(); }
