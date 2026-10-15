#!/usr/bin/env node
/**
 * Register the bundled worker with Sentry and record the artifact hash.
 * Reads SENTRY_AUTH_TOKEN from the environment (Infisical via deploy.sh).
 * Never prints secret values.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundlePath = path.join(root, "dist", "fleetlink-api.mjs");
const outDir = path.join(root, ".sentry-release");

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function sha256File(filePath) {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function runSentryCli(args, env) {
  return spawnSync("npx", ["--yes", "@sentry/cli", ...args], {
    cwd: root,
    encoding: "utf8",
    env
  });
}

const release = (process.env.SENTRY_RELEASE || gitHead()).trim();
if (!release) {
  console.error("sentry-release: could not resolve SENTRY_RELEASE or git HEAD");
  process.exit(1);
}

let bundleSha = "";
try {
  bundleSha = sha256File(bundlePath);
} catch {
  console.error("sentry-release: bundle missing at dist/fleetlink-api.mjs.  Run scripts/bundle-worker.mjs first.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const manifest = {
  release,
  artifact: "fleetlink-api.mjs",
  sha256: bundleSha,
  recorded_at: new Date().toISOString()
};
writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const token = process.env.SENTRY_AUTH_TOKEN?.trim();
if (!token) {
  console.log("SENTRY_AUTH_TOKEN is unset; wrote local manifest only.");
  process.exit(0);
}

const sentryEnv = {
  ...process.env,
  SENTRY_ORG: process.env.SENTRY_ORG || "simple-with-us",
  SENTRY_PROJECT: process.env.SENTRY_PROJECT || "fleetlink"
};

const created = runSentryCli(["releases", "new", release], sentryEnv);
if (created.status !== 0) {
  const combined = `${created.stdout || ""}${created.stderr || ""}`;
  if (!/already exists/i.test(combined)) {
    console.error("sentry-release: releases new failed");
    process.exit(created.status || 1);
  }
}

const uploaded = runSentryCli([
  "releases",
  "files",
  release,
  "upload",
  bundlePath,
  "--name",
  "fleetlink-api.mjs"
], sentryEnv);
if (uploaded.status !== 0) {
  console.error("sentry-release: artifact upload failed");
  process.exit(uploaded.status || 1);
}

const finalized = runSentryCli(["releases", "finalize", release], sentryEnv);
if (finalized.status !== 0) {
  console.error("sentry-release: releases finalize failed");
  process.exit(finalized.status || 1);
}

console.log(`Sentry release ${release} recorded with artifact sha256 ${bundleSha.slice(0, 12)}...`);
