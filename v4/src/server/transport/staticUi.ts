import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the built Svelte UI from `uiRoot`. Unknown non-asset paths fall back to
 * index.html (single-page app); asset misses return 404. Includes a
 * path-traversal guard so requests can never escape the UI directory.
 */
export async function serveStaticUi(uiRoot: string, reqPath: string, res: ServerResponse): Promise<void> {
  let rel = safeDecode(reqPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = normalize(join(uiRoot, rel));
  if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.setHeader("content-type", TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
    res.end(data);
  } catch {
    // SPA fallback: serve index.html for client-side routes, but never for missing assets.
    if (!rel.startsWith("/assets/")) {
      try {
        const html = await readFile(join(uiRoot, "index.html"));
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
        return;
      } catch {
        // fall through to 404
      }
    }
    res.writeHead(404).end("not found");
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
