#!/usr/bin/env node
// Runs remote D1 migrations and deploys the Worker, using gitignored wrangler.local.jsonc when present
// (created by `npm run setup`) or wrangler.jsonc (used by Cloudflare's Deploy to Workers button).
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const cfg = fs.existsSync("wrangler.local.jsonc") ? ["-c", "wrangler.local.jsonc"] : [];
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote", ...cfg], { stdio: "inherit" });
execFileSync("npx", ["wrangler", "deploy", ...cfg], { stdio: "inherit" });
