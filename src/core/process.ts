import { spawn } from "node:child_process";
import { DeskError } from "./errors";
export class Redactor {
  private secrets = new Set<string>();
  add(...values: (string | undefined)[]) {
    for (const value of values)
      if (value && value.length >= 3) {
        this.secrets.add(value);
        for (const line of value.split(/\r?\n/))
          if (line.length >= 8) this.secrets.add(line);
      }
  }
  redact(text: string) {
    let result = text.replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    );
    for (const value of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(value).join("[REDACTED]");
    return result
      .replace(/(Bearer\s+)[\w.\-]+/gi, "$1[REDACTED]")
      .replace(
        /((?:password|token|secret|private_key)\s*[=:]\s*)[^\s,]+/gi,
        "$1[REDACTED]",
      );
  }
}
export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  log?: (line: string) => void;
  input?: string;
  inputAfter?: RegExp;
  secrets?: Redactor;
  allowFailure?: boolean;
  timeout?: number;
}
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}
export async function run(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted)
    throw new DeskError("CANCELLED", "Operation cancelled.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      settled = false,
      timedOut = false,
      stopTimer: NodeJS.Timeout | undefined;
    const buffers = { stdout: "", stderr: "" };
    let promptBuffer = "",
      inputSent = false;
    const redact = (s: string) => options.secrets?.redact(s) ?? s;
    const emit = (key: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString();
      if (options.inputAfter && options.input && !inputSent) {
        promptBuffer = (promptBuffer + value)
          .slice(-4096)
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
        if (options.inputAfter.test(promptBuffer)) {
          inputSent = true;
          child.stdin.end(options.input);
        }
      }
      if (key === "stdout") stdout = (stdout + value).slice(-32 * 1024 * 1024);
      else stderr = (stderr + value).slice(-32 * 1024 * 1024);
      buffers[key] += value;
      const lines = buffers[key].split(/\r?\n|\r/);
      buffers[key] = lines.pop() ?? "";
      for (const line of lines) if (line) options.log?.(redact(line));
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid)
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            signal,
          );
      } catch {}
    };
    const abort = () => {
      kill("SIGTERM");
      stopTimer = setTimeout(() => kill("SIGKILL"), 3000);
      stopTimer.unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          abort();
        }, options.timeout)
      : undefined;
    child.stdout.on("data", (chunk) => emit("stdout", chunk));
    child.stderr.on("data", (chunk) => emit("stderr", chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new DeskError("TOOL_UNAVAILABLE", `${command}: ${error.message}`),
        );
      }
    });
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
    };
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const value of Object.values(buffers))
        if (value) options.log?.(redact(value));
      if (timedOut)
        return reject(
          new DeskError(
            "COMMAND_TIMEOUT",
            `${command} exceeded its ${options.timeout}ms timeout.`,
          ),
        );
      if (options.signal?.aborted)
        return reject(new DeskError("CANCELLED", "Operation cancelled."));
      if (code !== 0 && !options.allowFailure)
        return reject(
          new DeskError(
            "COMMAND_FAILED",
            `${command} exited with ${code ?? "a signal"}.\n${redact((stderr || stdout).slice(-6000))}`,
          ),
        );
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.on("error", () => {});
    if (options.input && !options.inputAfter) child.stdin.end(options.input);
    else if (options.inputAfter && options.input) {
      /* Wait for the known tool prompt. */
    } else child.stdin.end();
  });
}
export async function existsCommand(
  command: string,
  args = ["--version"],
  env?: NodeJS.ProcessEnv,
) {
  try {
    const result = await run(command, args, {
      env,
      allowFailure: true,
      timeout: 15000,
    });
    return result.code === 0
      ? (result.stdout || result.stderr).trim()
      : undefined;
  } catch {
    return undefined;
  }
}
