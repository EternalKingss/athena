import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal, dependency-free .env loader. Populates process.env (without
 * overwriting values already set in the real environment) and returns the names
 * of the keys it loaded — never the values, so callers can log safely.
 */
export function loadDotEnv(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

export function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}
