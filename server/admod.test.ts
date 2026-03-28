import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    platformRole: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createModeratorContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "mod-user",
    email: "mod@example.com",
    name: "Moderator User",
    loginMethod: "manus",
    role: "user",
    platformRole: "moderator",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createViewerContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 3,
    openId: "viewer-user",
    email: "viewer@example.com",
    name: "Viewer User",
    loginMethod: "manus",
    role: "user",
    platformRole: "viewer",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// ─── Auth Tests ───────────────────────────────────────────────────────────────

describe("auth", () => {
  it("auth.me returns user for authenticated context", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeDefined();
    expect(result?.openId).toBe("admin-user");
    expect(result?.role).toBe("admin");
  });

  it("auth.me returns null for unauthenticated context", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("auth.logout returns success", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
  });
});

// ─── RBAC Tests ───────────────────────────────────────────────────────────────

describe("role-based access control", () => {
  it("admin can access users.list", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    // Should not throw
    const result = await caller.users.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("non-admin cannot access users.list", async () => {
    const ctx = createViewerContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.users.list()).rejects.toThrow();
  });

  it("unauthenticated user cannot access protected routes", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.dashboard.stats()).rejects.toThrow();
  });

  it("admin can access policies.list", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.policies.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("admin can access audit.list", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.audit.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("non-admin cannot access audit.list", async () => {
    const ctx = createViewerContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.audit.list()).rejects.toThrow();
  });
});

// ─── Dashboard Tests ──────────────────────────────────────────────────────────

describe("dashboard", () => {
  it("dashboard.stats returns expected shape", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const stats = await caller.dashboard.stats();
    expect(stats).toBeDefined();
    expect(typeof stats.totalAds).toBe("number");
    expect(typeof stats.pendingReview).toBe("number");
    expect(typeof stats.approved).toBe("number");
    expect(typeof stats.rejected).toBe("number");
  });

  it("dashboard.adCounts returns object", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const counts = await caller.dashboard.adCounts();
    expect(counts).toBeDefined();
    expect(typeof counts).toBe("object");
  });

  it("dashboard.recentActivity returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const activity = await caller.dashboard.recentActivity();
    expect(Array.isArray(activity)).toBe(true);
  });
});

// ─── Ads Tests ────────────────────────────────────────────────────────────────

describe("ads", () => {
  it("ads.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.ads.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("ads.list with filters returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.ads.list({ status: "submitted", format: "image" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("ads.getById throws for non-existent ad", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.ads.getById({ id: 999999 })).rejects.toThrow("Ad not found");
  });
});

// ─── Advertisers Tests ────────────────────────────────────────────────────────

describe("advertisers", () => {
  it("advertisers.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.advertisers.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Policies Tests ───────────────────────────────────────────────────────────

describe("policies", () => {
  it("policies.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.policies.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("policies.seedTemplates creates compliance templates", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.policies.seedTemplates();
    expect(result.count).toBeGreaterThan(0);
    expect(result.ids.length).toBe(result.count);
  });
});

// ─── Reviews Tests ────────────────────────────────────────────────────────────

describe("reviews", () => {
  it("reviews.stats returns expected shape", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const stats = await caller.reviews.stats();
    expect(stats).toBeDefined();
    expect(typeof stats.total).toBe("number");
    expect(typeof stats.today).toBe("number");
  });
});

// ─── Violations Tests ─────────────────────────────────────────────────────────

describe("violations", () => {
  it("violations.stats returns expected shape", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const stats = await caller.violations.stats();
    expect(stats).toBeDefined();
    expect(typeof stats.total).toBe("number");
    expect(typeof stats.open).toBe("number");
  });
});

// ─── Approval Chains Tests ────────────────────────────────────────────────────

describe("approvalChains", () => {
  it("approvalChains.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.approvalChains.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Notifications Tests ──────────────────────────────────────────────────────

describe("notifications", () => {
  it("notifications.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.notifications.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("notifications.unreadCount returns number", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const count = await caller.notifications.unreadCount();
    expect(typeof count).toBe("number");
  });
});

// ─── Category Blocks Tests ────────────────────────────────────────────────────

describe("categoryBlocks", () => {
  it("categoryBlocks.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.categoryBlocks.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Integrations Tests ───────────────────────────────────────────────────────

describe("integrations", () => {
  it("integrations.list returns array", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.integrations.list();
    expect(Array.isArray(result)).toBe(true);
  });
});
