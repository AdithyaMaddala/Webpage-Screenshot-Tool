// Local dev server: serves /public and routes /api/screenshot to the same
// handler Vercel runs. No Vercel account needed. Usage: npm run dev
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/screenshot.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    if (pathname === "/api/screenshot") return handler(req, res);

    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, () => {
    console.log(`UI   → http://localhost:${PORT}`);
    console.log(`API  → http://localhost:${PORT}/api/screenshot?url=https://example.com`);
  });
