import { pathToFileURL } from "node:url";
import {
  larkCliStatus,
  printLarkCliBootstrap,
  runLarkCli,
  runLarkCliInteractive,
  parseLastJsonObject,
} from "./feishu_lark_cli_client.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      out[match[1]] = match[2];
    } else if (arg.startsWith("--")) {
      out[arg.slice(2)] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function printCommandResult(args, { parseJson = true, timeoutMs = 120000 } = {}) {
  const result = await runLarkCli(args, { timeoutMs });
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (parseJson && combined) {
    try {
      printJson({ command: result.commandLabel, exitCode: result.code, result: parseLastJsonObject(combined) });
      return result.code;
    } catch {
      // Fall through to raw output.
    }
  }
  if (combined) console.log(combined);
  return result.code;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || "status";

  if (command === "bootstrap") {
    console.log(printLarkCliBootstrap());
    return 0;
  }

  if (command === "status" || command === "doctor") {
    try {
      const status = await larkCliStatus();
      printJson(status);
      if (status.parsed?.ok === false) return 1;
      if (command === "doctor") {
        await printCommandResult(["auth", "status", "--json", "--verify"], { timeoutMs: 120000 });
      }
      return 0;
    } catch (error) {
      printJson({
        ok: false,
        error: error.message,
        nextStep: "Run: node build\\automation\\feishu_auth_setup.mjs bootstrap",
      });
      return 1;
    }
  }

  if (command === "config-init") {
    console.log("This command may wait for browser setup. Keep the terminal open until lark-cli reports success.");
    const initArgs = ["config", "init", "--new", "--lang", args.lang || "zh"];
    if (args["force-init"]) initArgs.push("--force-init");
    const result = await runLarkCliInteractive(initArgs);
    return result.code;
  }

  if (command === "login") {
    const loginArgs = ["auth", "login", "--recommend", "--domain", args.domain || "sheets,drive,wiki", "--json"];
    if (!args.wait) loginArgs.push("--no-wait");
    if (args.scope) loginArgs.push("--scope", args.scope);
    return printCommandResult(loginArgs, { timeoutMs: Number(args.timeout || 300000) });
  }

  if (command === "resume") {
    if (!args["device-code"]) throw new Error("resume requires --device-code=<code>.");
    return printCommandResult(["auth", "login", "--device-code", args["device-code"], "--json"], {
      timeoutMs: Number(args.timeout || 300000),
    });
  }

  if (command === "check") {
    const scope = args.scope || args._[1];
    if (!scope) throw new Error("check requires --scope=<scope>.");
    return printCommandResult(["auth", "check", scope, "--json"], { timeoutMs: 60000 });
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
