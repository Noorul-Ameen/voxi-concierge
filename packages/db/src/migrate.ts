import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const { db, close } = createDb(undefined, { max: 1 });
await migrate(db, { migrationsFolder: dir });
await close();
console.log("migrations applied");
