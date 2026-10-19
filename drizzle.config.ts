import { defineConfig } from "drizzle-kit";

/**
 * Конфиг drizzle-kit.
 *
 * Прежний `drizzle.config.json` содержал захардкоженный персональный DSN
 * `postgresql://victorkhudyakov@127.0.0.1:5432/crypto_dev`: чужая машина и CI
 * не могли применить схему, а любое окружение требовало правки файла в
 * репозитории. Теперь адрес берётся из DATABASE_URL (с тем же значением по
 * умолчанию для локальной разработки), а каталог миграций объявлен явно.
 */
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/crypto_dev";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
