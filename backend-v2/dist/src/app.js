import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { accommodationRouter } from "./modules/accommodation/accommodation.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { advancesRouter } from "./modules/advances/advances.routes.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { attendanceRouter } from "./modules/attendance/attendance.routes.js";
import { claimsRouter } from "./modules/claims/claims.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { inboxRouter } from "./modules/inbox/inbox.routes.js";
import { overtimeRouter } from "./modules/overtime/overtime.routes.js";
export function createApp() {
    const app = express();
    app.use(cors({
        origin: env.CORS_ORIGIN || true,
        credentials: true
    }));
    app.use(express.json({ limit: "2mb" }));
    app.use(requestLogger);
    app.use("/health", healthRouter);
    app.use("/auth", authRouter);
    app.use("/advances", advancesRouter);
    app.use("/accommodation-requests", accommodationRouter);
    app.use("/claims", claimsRouter);
    app.use("/inbox", inboxRouter);
    app.use("/attendance", attendanceRouter);
    app.use("/overtime", overtimeRouter);
    app.use("/ai", aiRouter);
    app.use(errorHandler);
    return app;
}
