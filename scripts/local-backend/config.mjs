// Shared configuration for the local backend harness (LOCAL DEVELOPMENT ONLY).
//
// Everything here is a dev-only default. The JWT secret and the keys derived
// from it are public knowledge; never reuse them for a hosted project.

import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export const BIN_DIR = process.env.LOCAL_BACKEND_BIN_DIR
  ? path.resolve(process.env.LOCAL_BACKEND_BIN_DIR)
  : path.join(HERE, ".bin");
export const RUN_DIR = path.join(HERE, ".run");

export const POSTGREST_BIN = path.join(BIN_DIR, "postgrest");
export const AUTH_BIN = path.join(BIN_DIR, "auth");
export const AUTH_MIGRATIONS_DIR = path.join(BIN_DIR, "auth-migrations");

export const APP_MIGRATIONS_DIR = process.env.LOCAL_BACKEND_MIGRATIONS_DIR
  ? path.resolve(process.env.LOCAL_BACKEND_MIGRATIONS_DIR)
  : path.join(REPO_ROOT, "supabase", "migrations");
export const SHIM_FILE = path.join(REPO_ROOT, "supabase", "tests", "local_shim.sql");

export const DOWNLOADS = {
  postgrest: {
    version: "13.0.7",
    url: "https://github.com/PostgREST/postgrest/releases/download/v13.0.7/postgrest-v13.0.7-linux-static-x86-64.tar.xz",
  },
  auth: {
    version: "2.185.0",
    url: "https://github.com/supabase/auth/releases/download/v2.185.0/auth-v2.185.0-x86.tar.gz",
  },
};

// Postgres --------------------------------------------------------------------
// The harness only ever touches this one database. It is not configurable on
// purpose: other databases on the same cluster (e.g. bingo_test) belong to
// other tools and must never be dropped by `reset`.
export const PG_HOST = "127.0.0.1";
export const PG_PORT = 54329;
export const DB_NAME = "bingo_local";
export const ADMIN_DB_URL = `postgresql://postgres@${PG_HOST}:${PG_PORT}/postgres`;
export const DB_URL = `postgresql://postgres@${PG_HOST}:${PG_PORT}/${DB_NAME}`;
// GoTrue must run with search_path=auth (hosted Supabase sets this on the
// supabase_auth_admin role). Some of its migrations create types unqualified,
// and without it they land in `public` and a later migration fails.
export const AUTH_DB_URL = `${DB_URL}?search_path=auth`;
export const POSTGREST_DB_URL = `postgres://authenticator:postgres@${PG_HOST}:${PG_PORT}/${DB_NAME}`;

// Ports -----------------------------------------------------------------------
export const HOST = "127.0.0.1";
export const PROXY_PORT = 54321;
export const POSTGREST_PORT = 54323;
export const AUTH_PORT = 54324;
export const API_URL = `http://${HOST}:${PROXY_PORT}`;

// JWT -------------------------------------------------------------------------
const DEFAULT_JWT_SECRET = "bingo-local-backend-dev-only-jwt-secret-0123456789abcdef01234567";
export const JWT_SECRET = process.env.LOCAL_BACKEND_JWT_SECRET || DEFAULT_JWT_SECRET;
if (JWT_SECRET.length < 32) {
  throw new Error("LOCAL_BACKEND_JWT_SECRET must be at least 32 characters (PostgREST requirement).");
}

const b64url = (input) => Buffer.from(input).toString("base64url");

/** Signs an HS256 JWT with the harness secret. */
export function signJwt(payload, secret = JWT_SECRET) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

// The API keys use a fixed `iat` so they stay identical across runs: values
// pasted into .env.local keep working after every restart or reset.
const KEY_IAT = 1767225600; // 2026-01-01T00:00:00Z
const TEN_YEARS = 10 * 365 * 24 * 60 * 60;

function apiKey(role) {
  return signJwt({ iss: "supabase-local", role, iat: KEY_IAT, exp: KEY_IAT + TEN_YEARS });
}

export const ANON_KEY = apiKey("anon");
export const SERVICE_ROLE_KEY = apiKey("service_role");

/** The lines to paste into .env.local. */
export function envLines() {
  return [
    "# Local backend harness (scripts/local-backend). Local development only.",
    `NEXT_PUBLIC_SUPABASE_URL=${API_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}`,
    "# Server-only (cleanup cron route). Never prefix with NEXT_PUBLIC_.",
    `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
    "NEXT_PUBLIC_APP_URL=http://localhost:3000",
  ];
}

// Process configuration -------------------------------------------------------

export function postgrestConfig() {
  return [
    `db-uri = "${POSTGREST_DB_URL}"`,
    `db-schemas = "public"`,
    `db-anon-role = "anon"`,
    `jwt-secret = "${JWT_SECRET}"`,
    `server-host = "${HOST}"`,
    `server-port = ${POSTGREST_PORT}`,
    `db-pool = 10`,
    `log-level = "warn"`,
    "",
  ].join("\n");
}

/** Environment for both `auth migrate` and `auth serve`. */
export function authEnv() {
  return {
    GOTRUE_API_HOST: HOST,
    PORT: String(AUTH_PORT),
    API_EXTERNAL_URL: `${API_URL}/auth/v1`,
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: AUTH_DB_URL,
    GOTRUE_DB_NAMESPACE: "auth",
    GOTRUE_DB_MIGRATIONS_PATH: AUTH_MIGRATIONS_DIR,
    GOTRUE_JWT_SECRET: JWT_SECRET,
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_SITE_URL: "http://localhost:3000",
    GOTRUE_URI_ALLOW_LIST: "http://localhost:3000,http://127.0.0.1:3000",
    GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "true",
    GOTRUE_DISABLE_SIGNUP: "false",
    GOTRUE_MAILER_AUTOCONFIRM: "true",
    GOTRUE_SMS_AUTOCONFIRM: "true",
    GOTRUE_LOG_LEVEL: "warn",
    GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: "1000",
    GOTRUE_RATE_LIMIT_TOKEN_REFRESH: "1000",
  };
}
