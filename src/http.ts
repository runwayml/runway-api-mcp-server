import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `__dirname` is `src/` under tsx and `build/` under node. The repo's
// `assets/` folder sits one level up in both cases (and is copied alongside
// `build/` inside the DXT bundle).
const ASSETS_DIR = path.join(__dirname, "..", "assets");

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/icon.png", (_req, res) => {
  res.sendFile(path.join(ASSETS_DIR, "runway-logo.png"));
});

// claude.ai connects from a different origin; allow it (and any other) so
// the browser preflight passes. Tighten with an explicit allowlist if you
// need to restrict access.
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: ["Content-Type", "Mcp-Session-Id", "Authorization"],
  })
);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// REQUIRE_AUTH=true rejects requests that don't include a Bearer token.
// Use this for public, multi-tenant deployments where each user supplies
// their own Runway API key. Default is false so single-user deployments
// (where you set RUNWAYML_API_SECRET on the server) keep working.
const REQUIRE_AUTH =
  (process.env.REQUIRE_AUTH ?? "").toLowerCase() === "true" ||
  process.env.REQUIRE_AUTH === "1";

// Per the MCP TypeScript SDK example for stateless mode: spin up a fresh
// server + transport per request so concurrent calls can't trample each
// other's state. The server registration is cheap.
async function handleMcpRequest(req: express.Request, res: express.Response) {
  try {
    // Per-request override: clients pass their Runway key via
    // `Authorization: Bearer <key>`. Falls back to RUNWAYML_API_SECRET on
    // the host only if REQUIRE_AUTH is false.
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ")
      ? auth.slice(7).trim()
      : undefined;

    if (REQUIRE_AUTH && !bearer) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Missing Runway API key. Send Authorization: Bearer <runwayml_api_secret>.",
        },
        id: null,
      });
      return;
    }

    // bearer takes priority; if undefined, createServer falls back to the
    // RUNWAYML_API_SECRET env var (only reachable when REQUIRE_AUTH=false).
    const server = createServer({ runwayApiSecret: bearer });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.delete("/mcp", handleMcpRequest);

app.listen(PORT, HOST, () => {
  console.log(`Runway MCP HTTP server listening at http://${HOST}:${PORT}/mcp`);
});
