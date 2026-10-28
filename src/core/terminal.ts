import { run, type CommandOptions } from "./process";

// macOS script(1) requires its own stdin to be a terminal. Electron's child
// stdin is a socket, so use Python's standard-library PTY bridge instead.
// Xcode supplies /usr/bin/python3. No shell interpolation or user script runs.
const bridge = `
import os, pty, select, signal, sys, time
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
deadline = None
def forward(sig, frame):
    global deadline
    try: os.killpg(pid, sig)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 2
signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
input_open = True
while True:
    if deadline is not None and time.monotonic() >= deadline:
        try: os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        deadline = None
    readable, _, _ = select.select([master] + ([0] if input_open else []), [], [], 0.1)
    if master in readable:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if 0 in readable:
        data = os.read(0, 65536)
        if data: os.write(master, data)
        else: input_open = False
os.close(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;
export function terminalInvocation(command: string, args: string[]) {
  return {
    command: "/usr/bin/python3",
    args: ["-c", bridge, command, ...args],
  };
}
export function runTerminal(
  command: string,
  args: string[],
  options: CommandOptions,
) {
  const invocation = terminalInvocation(command, args);
  return run(invocation.command, invocation.args, options);
}
