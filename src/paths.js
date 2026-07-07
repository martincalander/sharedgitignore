import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_VERSION = 1;
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function homeDir() {
  return os.homedir();
}

export function sharedgitignoreHome(env = process.env) {
  return path.resolve(env.SHAREDGITIGNORE_HOME || path.join(homeDir(), ".sharedgitignore"));
}

export function registryPath(env = process.env) {
  return path.join(sharedgitignoreHome(env), "registry.json");
}

export function repoRootForCwd(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  try {
    const output = execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!output) throw new Error("empty git output");
    return path.resolve(output);
  } catch {
    throw new Error(`not a Git repository: ${resolved}`);
  }
}

export function gitignorePath(repoRoot) {
  return path.join(repoRoot, ".gitignore");
}
