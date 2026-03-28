export const ENV = {
  // Database
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Auth
  jwtSecret: process.env.JWT_SECRET ?? "",
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@admod.local",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",

  // Google OAuth (optional — set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable)
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",

  // LLM
  llmProvider: process.env.LLM_PROVIDER ?? "openai",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  // S3
  s3Bucket: process.env.S3_BUCKET ?? "admod-uploads",

  // Server
  isProduction: process.env.NODE_ENV === "production",
  port: parseInt(process.env.PORT || "3000"),

  // Legacy compat (used by some callers)
  cookieSecret: process.env.JWT_SECRET ?? "",
};
