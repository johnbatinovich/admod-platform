import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerAuthRoutes, registerGoogleOAuthRoutes, bootstrapAdminUser } from "./auth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function logStartupDiagnostics() {
  console.log("─────────────────────────────────────────────────");
  console.log("[Startup] AdMod Platform — configuration check");

  // LLM provider
  const provider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "NONE");
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  console.log(`[Startup] LLM_PROVIDER env: ${process.env.LLM_PROVIDER ?? "(not set, auto-detected)"}`);
  console.log(`[Startup] Active provider: ${provider}`);
  console.log(`[Startup] OPENAI_API_KEY: ${openaiKey ? `✅ present (${openaiKey.slice(0, 8)}...)` : "❌ NOT SET"}`);
  console.log(`[Startup] ANTHROPIC_API_KEY: ${anthropicKey ? `✅ present (${anthropicKey.slice(0, 8)}...)` : "❌ NOT SET"}`);

  // S3 / R2 config
  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY;
  console.log(`[Startup] S3_ENDPOINT: ${s3Endpoint ? `✅ ${s3Endpoint}` : "❌ NOT SET"}`);
  console.log(`[Startup] S3_BUCKET: ${s3Bucket ? `✅ ${s3Bucket}` : "❌ NOT SET (default: admod-uploads)"}`);
  console.log(`[Startup] S3_ACCESS_KEY_ID: ${s3AccessKey ? `✅ present (${s3AccessKey.slice(0, 8)}...)` : "❌ NOT SET"}`);
  console.log(`[Startup] S3_SECRET_ACCESS_KEY: ${s3SecretKey ? "✅ present" : "❌ NOT SET"}`);

  // Database
  const dbUrl = process.env.DATABASE_URL;
  console.log(`[Startup] DATABASE_URL: ${dbUrl ? `✅ present (${dbUrl.slice(0, 20)}...)` : "❌ NOT SET"}`);

  // R2 connectivity test
  if (s3AccessKey && s3SecretKey) {
    try {
      const { storagePut } = await import("../storage");
      const testKey = `_healthcheck/startup-${Date.now()}.txt`;
      await storagePut(testKey, Buffer.from("ok"), "text/plain");
      console.log(`[Startup] R2/S3 write test: ✅ SUCCESS (wrote ${testKey})`);
    } catch (err) {
      console.error(`[Startup] R2/S3 write test: ❌ FAILED — ${(err as Error).message}`);
    }
  } else {
    console.warn(`[Startup] R2/S3 write test: ⚠️  SKIPPED (credentials missing)`);
  }

  // ffmpeg / yt-dlp availability
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const ffmpegOut = await execAsync("which ffmpeg").catch(() => ({ stdout: "" }));
    const ffprobeOut = await execAsync("which ffprobe").catch(() => ({ stdout: "" }));
    const ytdlpOut = await execAsync("which yt-dlp").catch(() => ({ stdout: "" }));
    console.log(`[Startup] ffmpeg: ${ffmpegOut.stdout.trim() || "❌ NOT FOUND IN PATH"}`);
    console.log(`[Startup] ffprobe: ${ffprobeOut.stdout.trim() || "❌ NOT FOUND IN PATH"}`);
    console.log(`[Startup] yt-dlp: ${ytdlpOut.stdout.trim() || "❌ NOT FOUND IN PATH (YouTube/Vimeo analysis will fail)"}`);
  } catch (err) {
    console.warn(`[Startup] Tool check failed: ${(err as Error).message}`);
  }

  // Frame extraction dir
  const frameDir = process.env.FRAME_EXTRACT_DIR || "/tmp/admod-frames";
  const { mkdirSync, existsSync } = await import("fs");
  if (!existsSync(frameDir)) {
    try { mkdirSync(frameDir, { recursive: true }); console.log(`[Startup] Frame dir: created ${frameDir}`); }
    catch (err) { console.error(`[Startup] Frame dir: ❌ could not create ${frameDir} — ${(err as Error).message}`); }
  } else {
    console.log(`[Startup] Frame dir: ✅ exists ${frameDir}`);
  }

  console.log("─────────────────────────────────────────────────");
}

async function startServer() {
  await logStartupDiagnostics();
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Auth routes (login, register, google oauth)
  registerAuthRoutes(app);
  registerGoogleOAuthRoutes(app);
  // Bootstrap admin user on first boot
  await bootstrapAdminUser();
  // Health check
  app.get("/health", async (_req, res) => {
    const checks: Record<string, string> = {};

    // Database
    try {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (db) { checks.database = "ok"; } else { checks.database = "unavailable"; }
    } catch { checks.database = "error"; }

    // Storage
    const s3Key = process.env.S3_ACCESS_KEY_ID;
    const s3Secret = process.env.S3_SECRET_ACCESS_KEY;
    checks.storage = s3Key && s3Secret ? "configured" : "not_configured";

    // LLM
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    checks.llm = openaiKey || anthropicKey ? "configured" : "not_configured";

    // ffmpeg
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      await promisify(exec)("which ffmpeg");
      checks.ffmpeg = "ok";
    } catch { checks.ffmpeg = "not_found"; }

    const allOk = checks.database === "ok";
    res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", ...checks, timestamp: new Date().toISOString() });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
