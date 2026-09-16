// brain-worker.js — runs Codex CLI queries in an isolated child process
// Forked by server.js so brain crashes/hangs can't take down the server
const { spawn } = require("child_process");
const readline = require("readline");

function buildArgs({ sessionId, cwd, model, reasoningEffort }) {
  if (sessionId) {
    const args = [
      "exec", "resume", sessionId,
      "--json",
      "--skip-git-repo-check",
      "-m", model || "gpt-5.4",
    ];
    if (reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    args.push("-");
    return args;
  }

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-m", model || "gpt-5.4",
  ];

  if (reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  if (cwd) args.push("-C", cwd);
  args.push("-");
  return args;
}

function buildPrompt(systemPrompt, prompt, isResume) {
  if (isResume) return prompt;
  return `${systemPrompt}\n\n${prompt}`;
}

process.on("message", async (msg) => {
  if (msg.type !== "run") return;

  const { prompt, systemPrompt, sessionId, cwd, codexPath, model, reasoningEffort } = msg;
  const args = buildArgs({ sessionId, cwd, model, reasoningEffort });
  const child = spawn(codexPath || "codex", args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let finalText = "";
  let threadId = sessionId || null;
  let usage = null;
  let numTurns = 0;
  let stderr = "";
  let textStarted = false;
  let finished = false;

  const rl = readline.createInterface({ input: child.stdout });

  function finish(code) {
    if (finished) return;
    finished = true;
    try { rl.close(); } catch {}
    setImmediate(() => process.exit(code));
  }

  function appendText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    if (!textStarted) {
      textStarted = true;
      process.send({ type: "event", event: "text_start" });
    }
    finalText = finalText ? `${finalText}\n\n${trimmed}` : trimmed;
    process.send({ type: "event", event: "text_delta", text: trimmed, accumulated: finalText });
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "thread.started") {
      threadId = event.thread_id || threadId;
      return;
    }

    if (event.type === "turn.started") {
      process.send({ type: "event", event: "thinking_start" });
      return;
    }

    if (event.type === "item.started" && event.item?.type === "command_execution") {
      process.send({ type: "event", event: "tool_start", name: "Bash" });
      return;
    }

    if (event.type === "item.completed") {
      const item = event.item || {};
      if (item.type === "agent_message") {
        appendText(item.text);
      } else if (item.type === "command_execution") {
        process.send({
          type: "event",
          event: "tool_use",
          name: "Bash",
          input: String(item.command || "").slice(0, 160),
        });
        if (item.aggregated_output) {
          process.send({
            type: "event",
            event: "tool_result",
            summary: String(item.aggregated_output).slice(0, 160),
          });
        }
      }
      return;
    }

    if (event.type === "turn.completed") {
      usage = event.usage || null;
      numTurns += 1;
      process.send({ type: "event", event: "thinking_done" });
      process.send({
        type: "result",
        sessionId: threadId,
        usage,
        numTurns,
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.on("error", (error) => {
    process.send({ type: "error", message: error.message, stderr });
    finish(1);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      process.send({
        type: "error",
        message: stderr.trim() || `Codex exited with code ${code}`,
        stderr,
      });
      finish(code || 1);
      return;
    }

    process.send({ type: "done", text: finalText });
    finish(0);
  });

  child.stdin.end(buildPrompt(systemPrompt, prompt, !!sessionId));
});
