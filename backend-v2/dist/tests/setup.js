"use strict";
process.env.NODE_ENV = "test";
process.env.PORT = process.env.PORT || "4100";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/advance_v2_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "v2-super-secret-token";
