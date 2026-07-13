import rateLimit from "express-rate-limit";

// Login is brute-forceable (email/password) and the email-action endpoints
// accept a bearer-style token as a URL path segment, which some proxies/logs
// may expose - both need throttling independent of the app's own JWT-based
// auth, which doesn't apply until after these succeed.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." }
});

export const emailActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." }
});
