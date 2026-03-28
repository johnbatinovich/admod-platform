export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Login is handled by local auth form — no external OAuth redirect needed.
export const getLoginUrl = () => "/login";
