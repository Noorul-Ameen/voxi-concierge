/** Never let integration tests or their seed helpers touch an application/remote database. */
export function assertLocalTestDatabase(value = process.env.DATABASE_URL): string {
  if (!value) throw new Error("DATABASE_URL must explicitly select a local *_test database");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/[a-zA-Z][a-zA-Z0-9_]*_test$/.test(url.pathname)
  ) {
    throw new Error("Tests require a local database whose name ends with _test; refusing this database");
  }
  return value;
}
