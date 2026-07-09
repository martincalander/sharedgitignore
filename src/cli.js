import packageJson from "../package.json" with { type: "json" };
import { installZshCompletion, zshCompletionScript } from "./completion.js";
import {
  addProfile,
  listProfiles,
  profileStatus,
  removeProfile
} from "./registry.js";
import {
  checkAllRepositories,
  checkRepository,
  detectRepository,
  initRepository,
  syncAllRepositories,
  syncRepository
} from "./repo.js";

const VERSION = packageJson.version;
const BOOLEAN_OPTION = Object.freeze({ type: "boolean", repeatable: false });
const VALUE_OPTION = Object.freeze({ type: "string", repeatable: false });

const COMMAND_OPTIONS = Object.freeze({
  help: {},
  profile: {
    add: {},
    remove: {},
    list: {},
    status: {}
  },
  completion: {
    zsh: {},
    install: { dir: VALUE_OPTION }
  },
  detect: { cwd: VALUE_OPTION, json: BOOLEAN_OPTION },
  init: { cwd: VALUE_OPTION, profile: VALUE_OPTION, "dry-run": BOOLEAN_OPTION },
  sync: { cwd: VALUE_OPTION, "dry-run": BOOLEAN_OPTION },
  check: { cwd: VALUE_OPTION },
  "sync-all": { root: VALUE_OPTION, "no-recursive": BOOLEAN_OPTION, "dry-run": BOOLEAN_OPTION },
  "check-all": { root: VALUE_OPTION, "no-recursive": BOOLEAN_OPTION }
});

function optionDefinitions(command, subcommand) {
  const commandDefinition = COMMAND_OPTIONS[command];
  let definitions = commandDefinition ?? {};
  if (["profile", "completion"].includes(command)) {
    definitions = subcommand && Object.hasOwn(commandDefinition, subcommand)
      ? commandDefinition[subcommand]
      : {};
  }
  return { ...definitions, help: BOOLEAN_OPTION };
}

function parseOptionToken(token) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) return { name: token.slice(2), inlineValue: undefined };
  return {
    name: token.slice(2, equalsIndex),
    inlineValue: token.slice(equalsIndex + 1)
  };
}

export function parseArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("arguments must be an array of strings");
  }
  if (args.length === 0) {
    return { command: "help", subcommand: null, flags: Object.create(null), positionals: [] };
  }
  if (args[0] === "--version") {
    if (args.length !== 1) throw new Error("--version does not accept additional arguments");
    return { command: "version", subcommand: null, flags: Object.create(null), positionals: [] };
  }
  if (args[0] === "--help") {
    if (args.length !== 1) throw new Error("--help does not accept additional arguments before a command");
    return { command: "help", subcommand: null, flags: Object.create(null), positionals: [] };
  }
  if (args[0].startsWith("--")) {
    throw new Error(`options must follow a command: ${args[0]}`);
  }

  const command = args[0];
  let index = 1;
  let subcommand = null;
  if (["profile", "completion"].includes(command) && args[index] && !args[index].startsWith("--")) {
    subcommand = args[index];
    index += 1;
  }

  const definitions = optionDefinitions(command, subcommand);
  const flags = Object.create(null);
  const positionals = [];
  let optionsEnded = false;

  while (index < args.length) {
    const token = args[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (optionsEnded || !token.startsWith("--")) {
      positionals.push(token);
      index += 1;
      continue;
    }

    const { name, inlineValue } = parseOptionToken(token);
    if (!name || !Object.hasOwn(definitions, name)) throw new Error(`Unknown option: --${name}`);
    const definition = definitions[name];
    if (Object.hasOwn(flags, name) && !definition.repeatable) {
      throw new Error(`Option may not be repeated: --${name}`);
    }

    if (definition.type === "boolean") {
      if (inlineValue !== undefined) throw new Error(`Option does not take a value: --${name}`);
      flags[name] = true;
      index += 1;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate === "--" || candidate.startsWith("--")) {
        throw new Error(`Option requires a value: --${name}`);
      }
      value = candidate;
      index += 1;
    }
    if (value.length === 0) throw new Error(`Option requires a non-empty value: --${name}`);
    flags[name] = definition.repeatable ? [...(flags[name] ?? []), value] : value;
    index += 1;
  }

  return { command, subcommand, flags, positionals };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assertNoPositionals(positionals, label) {
  if (positionals.length > 0) throw new Error(`${label} does not accept positional arguments`);
}

function printProfileList(env) {
  const profiles = listProfiles(env);
  if (profiles.length === 0) {
    process.stdout.write("no profiles registered\n");
    return;
  }
  for (const profile of profiles) {
    process.stdout.write(`${profile.id}\t${profile.path}\n`);
  }
}

function printProfileStatus(env) {
  const statuses = profileStatus(env);
  if (statuses.length === 0) {
    process.stdout.write("no profiles registered\n");
    return true;
  }
  for (const profile of statuses) {
    const state = profile.valid ? "ok" : `invalid: ${profile.errors.join("; ")}`;
    process.stdout.write(`${profile.id}\t${state}\t${profile.path}\n`);
  }
  return statuses.every((profile) => profile.valid);
}

function handleProfileCommand(subcommand, flags, positionals, env) {
  if (subcommand === "add") {
    const id = positionals[0];
    const templatePath = positionals[1];
    if (!id || !templatePath) throw new Error("profile add requires <id> <path>");
    if (positionals.length > 2) throw new Error("profile add accepts exactly <id> <path>");
    const profile = addProfile(id, templatePath, env);
    process.stdout.write(`${profile.id}\t${profile.path}\n`);
    return;
  }

  if (subcommand === "remove") {
    const id = positionals[0];
    if (!id) throw new Error("profile remove requires <id>");
    if (positionals.length > 1) throw new Error("profile remove accepts exactly <id>");
    const removed = removeProfile(id, env);
    process.stdout.write(`${removed ? "removed" : "missing"}\t${id}\n`);
    return;
  }

  if (subcommand === "list") {
    assertNoPositionals(positionals, "profile list");
    printProfileList(env);
    return;
  }

  if (subcommand === "status") {
    assertNoPositionals(positionals, "profile status");
    if (!printProfileStatus(env)) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown profile command: ${subcommand || "(missing)"}`);
}

function handleCompletionCommand(subcommand, flags, positionals, env) {
  if (subcommand === "zsh") {
    assertNoPositionals(positionals, "completion zsh");
    process.stdout.write(zshCompletionScript());
    return;
  }

  if (subcommand === "install") {
    assertNoPositionals(positionals, "completion install");
    const result = installZshCompletion({ dir: flags.dir, env });
    process.stdout.write(`${result.shell}\tinstalled\t${result.filePath}\n`);
    return;
  }

  throw new Error(`Unknown completion command: ${subcommand || "(missing)"}`);
}

function printDetect(result) {
  process.stdout.write(`cwd: ${result.cwd}\n`);
  process.stdout.write(`repo root: ${result.repoRoot}\n`);
  process.stdout.write(`.gitignore: ${result.gitignoreExists ? result.gitignorePath : "(missing)"}\n`);
  process.stdout.write(`managed block: ${result.hasBlock ? "yes" : "no"}\n`);
  process.stdout.write(`profile: ${result.profile ?? "(none)"}\n`);
  process.stdout.write(`template: ${result.templatePath ?? "(unknown)"}\n`);
  process.stdout.write(`in sync: ${result.inSync === null ? "(unknown)" : (result.inSync ? "yes" : "no")}\n`);
  process.stdout.write(`errors: ${result.errors.join("; ") || "(none)"}\n`);
}

function printCheckResult(result) {
  if (result.valid) {
    process.stdout.write(`ok\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  process.stdout.write(`invalid\t${result.repoRoot}\n`);
  for (const error of result.errors) {
    process.stdout.write(`error\t${error}\n`);
  }
}

function printAllResults(batch, mode) {
  for (const diagnostic of batch.diagnostics) {
    process.stdout.write(`scan-error\t${diagnostic.path}\t${diagnostic.error}\n`);
  }

  for (const result of batch.results) {
    if (result.skipped) {
      process.stdout.write(`skipped\t${result.repoRoot}\t${result.reason}\n`);
      continue;
    }

    if (mode === "check" && result.errors?.length === 1 && result.errors[0] === "managed block is stale") {
      process.stdout.write(`stale\t${result.profile}\t${result.repoRoot}\n`);
      continue;
    }

    if (result.errors && result.errors.length > 0) {
      process.stdout.write(`invalid\t${result.repoRoot}\t${result.errors.join("; ")}\n`);
      continue;
    }

    if (mode === "sync") {
      let state = "current";
      if (result.changed && result.applied) state = "updated";
      else if (result.changed && batch.dryRun) state = "would-update";
      else if (result.changed && batch.aborted) state = "not-updated";
      process.stdout.write(`${state}\t${result.profile}\t${result.repoRoot}\n`);
    } else {
      process.stdout.write(`${result.valid ? "ok" : "stale"}\t${result.profile}\t${result.repoRoot}\n`);
    }
  }

  if (mode === "sync" && batch.aborted) {
    const detail = batch.appliedCount === 0
      ? "no repositories updated"
      : `${batch.appliedCount} repositories updated before failure`;
    process.stdout.write(`aborted\t${batch.root}\t${detail}\n`);
  }
}

function hasFailures(batch, mode) {
  if (batch.diagnostics.length > 0) return true;
  if (mode === "sync" && batch.aborted) return true;
  return batch.results.some((result) => {
    if (result.skipped) return false;
    if (result.errors && result.errors.length > 0) return true;
    return mode === "check" && !result.valid;
  });
}

function help() {
  process.stdout.write(`sharedgitignore ${VERSION}

Usage:
  sharedgitignore --version
  sharedgitignore profile add <id> <path>
  sharedgitignore profile remove <id>
  sharedgitignore profile list
  sharedgitignore profile status
  sharedgitignore detect [--cwd path] [--json]
  sharedgitignore init --profile <id> [--cwd path] [--dry-run]
  sharedgitignore sync [--cwd path] [--dry-run]
  sharedgitignore check [--cwd path]
  sharedgitignore sync-all --root <path> [--no-recursive] [--dry-run]
  sharedgitignore check-all --root <path> [--no-recursive]
  sharedgitignore completion zsh
  sharedgitignore completion install [--dir path]

Options must follow their command (and subcommand, where present).
Use -- to end option parsing for positional IDs or paths.

sharedgitignore manages a generated shared block at the top of .gitignore.
Project-specific bytes stay below the managed block.
sync-all and check-all recurse into nested Git repos by default.
\n`);
}

export async function main(args, env = process.env) {
  const { command, subcommand, flags, positionals } = parseArgs(args);

  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.help || command === "help") {
    assertNoPositionals(positionals, "help");
    help();
    return;
  }

  if (command === "profile") {
    handleProfileCommand(subcommand, flags, positionals, env);
    return;
  }

  if (command === "completion") {
    handleCompletionCommand(subcommand, flags, positionals, env);
    return;
  }

  if (command === "detect") {
    assertNoPositionals(positionals, "detect");
    const result = detectRepository({ cwd: flags.cwd || process.cwd(), env });
    if (flags.json) printJson(result);
    else printDetect(result);
    return;
  }

  if (command === "init") {
    assertNoPositionals(positionals, "init");
    if (!flags.profile) throw new Error("init requires --profile <id>");
    const result = initRepository(flags.profile, {
      cwd: flags.cwd || process.cwd(),
      env,
      dryRun: flags["dry-run"] === true
    });
    const state = result.changed ? (result.dryRun ? "would-initialize" : "initialized") : "current";
    process.stdout.write(`${state}\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  if (command === "sync") {
    assertNoPositionals(positionals, "sync");
    const result = syncRepository({
      cwd: flags.cwd || process.cwd(),
      env,
      dryRun: flags["dry-run"] === true
    });
    const state = result.changed ? (result.dryRun ? "would-update" : "updated") : "current";
    process.stdout.write(`${state}\t${result.profile}\t${result.gitignorePath}\n`);
    return;
  }

  if (command === "check") {
    assertNoPositionals(positionals, "check");
    const result = checkRepository({ cwd: flags.cwd || process.cwd(), env });
    printCheckResult(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (command === "sync-all") {
    assertNoPositionals(positionals, "sync-all");
    if (!flags.root) throw new Error("sync-all requires --root <path>");
    const batch = syncAllRepositories({
      root: flags.root,
      recursive: !flags["no-recursive"],
      dryRun: flags["dry-run"] === true,
      env
    });
    printAllResults(batch, "sync");
    if (hasFailures(batch, "sync")) process.exitCode = 1;
    return;
  }

  if (command === "check-all") {
    assertNoPositionals(positionals, "check-all");
    if (!flags.root) throw new Error("check-all requires --root <path>");
    const batch = checkAllRepositories({
      root: flags.root,
      recursive: !flags["no-recursive"],
      env
    });
    printAllResults(batch, "check");
    if (hasFailures(batch, "check")) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
