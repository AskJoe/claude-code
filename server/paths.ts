import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = resolve(__dirname, "..");

export const DATA_ROOT = process.env.LAB_DATA_DIR
  ? resolve(process.env.LAB_DATA_DIR)
  : APP_ROOT;

export const DB_PATH = resolve(DATA_ROOT, "db", "lab.sqlite");
export const SESSIONS_ROOT = resolve(DATA_ROOT, "sessions");
export const TEMPLATE_DIR = resolve(APP_ROOT, "templates", "static-site");
