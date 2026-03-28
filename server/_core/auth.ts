/**
 * Standalone Authentication
 * 
 * Simple JWT-based auth with email/password login.
 * Replaces Manus OAuth with self-contained auth that works anywhere.
 * 
 * Supports:
 * - Email/password login
 * - JWT session tokens in httpOnly cookies
 * - Auto-creation of admin user on first boot
 * - Role-based access (viewer, reviewer, moderator, admin)
 */

import { SignJWT, jwtVerify } from "jose";
import { createHash } from "crypto";
import type { Request, Response, Express } from "express";
import * as db from "../db";
import { ENV } from "./env";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./cookies";
import type { User } from "../../drizzle/schema";

// ─── Password Hashing ───────────────────────────────────────────────────

function hashPassword(password: string): string {
  return createHash("sha256").update(password + ENV.jwtSecret).digest("hex");
}

function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

// ─── JWT Session ────────────────────────────────────────────────────────

const getSecret = () => new TextEncoder().encode(ENV.jwtSecret || "dev-secret-change-me");

export async function createSessionToken(
  openId: string,
  name: string,
  expiresInMs: number = ONE_YEAR_MS,
): Promise<string> {
  return new SignJWT({ openId, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + expiresInMs) / 1000))
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<{ openId: string; name: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.openId === "string" && typeof payload.name === "string") {
      return { openId: payload.openId, name: payload.name };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Request Authentication ─────────────────────────────────────────────

export async function authenticateRequest(req: Request): Promise<User | null> {
  // Try cookie first
  const cookieHeader = req.headers.cookie;
  let token: string | undefined;

  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map(c => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      })
    );
    token = cookies[COOKIE_NAME];
  }

  // Fall back to Authorization header
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  const user = await db.getUserByOpenId(session.openId);
  return user || null;
}

// ─── Auth Routes ────────────────────────────────────────────────────────

export function registerAuthRoutes(app: Express) {
  // Login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    try {
      const user = await db.getUserByEmail(email);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      // Check password (stored in openId field as hash for simplicity,
      // or use a separate passwords table in production)
      const passwordHash = hashPassword(password);
      if (user.openId !== passwordHash) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const sessionToken = await createSessionToken(
        user.openId,
        user.name || user.email || "User",
      );

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Update last sign in
      await db.upsertUser({
        openId: user.openId,
        name: user.name,
        email: user.email,
        lastSignedIn: new Date(),
      });

      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          platformRole: user.platformRole,
        },
      });
    } catch (error) {
      console.error("[Auth] Login failed:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Register (admin can create users, or self-registration)
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    try {
      // Check if user already exists
      const existing = await db.getUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: "User with this email already exists" });
        return;
      }

      const passwordHash = hashPassword(password);

      await db.upsertUser({
        openId: passwordHash,
        name: name || email.split("@")[0],
        email,
        loginMethod: "email",
        lastSignedIn: new Date(),
      });

      const user = await db.getUserByEmail(email);
      if (!user) {
        throw new Error("User creation failed");
      }

      const sessionToken = await createSessionToken(
        user.openId,
        user.name || "User",
      );

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          platformRole: user.platformRole,
        },
      });
    } catch (error) {
      console.error("[Auth] Registration failed:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });
}

// ─── Google OAuth ───────────────────────────────────────────────────────

export function registerGoogleOAuthRoutes(app: Express) {
  // Kick off Google OAuth — redirect user to Google's consent screen
  app.get("/api/auth/google", (req: Request, res: Response) => {
    const clientId = ENV.googleClientId;
    if (!clientId) {
      res.status(503).send("Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env");
      return;
    }
    const redirectUri = `${req.protocol}://${req.headers.host}/api/auth/google/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
  });

  // Google sends the user back here with ?code=...
  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const { code, error } = req.query;

    if (error || !code) {
      console.error("[Auth] Google OAuth error:", error);
      res.redirect("/login?error=google_cancelled");
      return;
    }

    const clientId = ENV.googleClientId;
    const clientSecret = ENV.googleClientSecret;
    const redirectUri = `${req.protocol}://${req.headers.host}/api/auth/google/callback`;

    try {
      // Exchange authorization code for access token
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code as string,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });

      const tokens = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokens.access_token) {
        console.error("[Auth] Google token exchange failed:", tokens);
        res.redirect("/login?error=google_failed");
        return;
      }

      // Fetch the Google user's profile
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const googleUser = (await userInfoRes.json()) as {
        id?: string;
        email?: string;
        name?: string;
        verified_email?: boolean;
      };

      if (!googleUser.email || !googleUser.id) {
        res.redirect("/login?error=google_no_email");
        return;
      }

      // Find existing user by email (case-insensitive), or create a new one
      let user = await db.getUserByEmail(googleUser.email);

      if (!user) {
        const openId = `google_${googleUser.id}`;
        await db.upsertUser({
          openId,
          name: googleUser.name || googleUser.email.split("@")[0],
          email: googleUser.email,
          loginMethod: "google",
          lastSignedIn: new Date(),
        });
        user = await db.getUserByEmail(googleUser.email);
      }

      if (!user) {
        res.redirect("/login?error=google_failed");
        return;
      }

      const sessionToken = await createSessionToken(
        user.openId,
        user.name || user.email || "User",
      );

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect("/");
    } catch (err) {
      console.error("[Auth] Google OAuth callback failed:", err);
      res.redirect("/login?error=google_failed");
    }
  });
}

// ─── Bootstrap Admin ────────────────────────────────────────────────────

/**
 * Create the initial admin user on first boot if no users exist.
 * Uses ADMIN_EMAIL and ADMIN_PASSWORD from environment.
 */
export async function bootstrapAdminUser(): Promise<void> {
  try {
    const users = await db.getAllUsers();
    if (users && users.length > 0) {
      console.log(`[Auth] ${users.length} users exist, skipping bootstrap`);
      return;
    }

    const email = ENV.adminEmail;
    const password = ENV.adminPassword;

    if (!password) {
      console.warn("[Auth] No ADMIN_PASSWORD set — skipping admin bootstrap. Set ADMIN_PASSWORD in .env");
      return;
    }

    const passwordHash = hashPassword(password);

    await db.upsertUser({
      openId: passwordHash,
      name: "Admin",
      email,
      loginMethod: "email",
      role: "admin",
      platformRole: "admin",
      lastSignedIn: new Date(),
    });

    console.log(`[Auth] Created admin user: ${email}`);
  } catch (error) {
    console.warn("[Auth] Bootstrap failed (database may not be ready):", error);
  }
}
