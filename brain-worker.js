// brain-worker.js — runs Agent SDK query in an isolated child process
// Forked by server.js so brain crashes/hangs can't take down the server
const { query } = require("@anthropic-ai/claude-agent-sdk");

process.on("message", async (msg) => {
  if (msg.type !== "run") return;

  const { prompt, systemPrompt, sessionId, cwd, claudePath } = msg;

  let finalText = "";
  let resultData = null;
  let thinkingChars = 0;

  const queryOpts = {
    prompt,
    options: {
      systemPrompt,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudePath,
      cwd,
    },
  };

  if (sessionId) queryOpts.options.resume = sessionId;

  try {
    for await (const message of query(queryOpts)) {
      if (message.type === "stream_event" && message.event) {
        const evt = message.event;

        if (evt.type === "content_block_start") {
          const cb = evt.content_block;
          if (cb && cb.type === "thinking") {
            thinkingChars = 0;
            process.send({ type: "event", event: "thinking_start" });
          } else if (cb && cb.type === "tool_use") {
            process.send({ type: "event", event: "tool_start", name: cb.name });
          } else if (cb && cb.type === "text") {
            process.send({ type: "event", event: "text_start" });
          }
        } else if (evt.type === "content_block_delta") {
          const d = evt.delta;
          if (d && d.type === "thinking_delta") {
            thinkingChars += (d.thinking || "").length;
            if (thinkingChars % 200 < 20) {
              process.send({ type: "event", event: "thinking_delta", length: thinkingChars });
            }
          } else if (d && d.type === "text_delta") {
            finalText += d.text || "";
            process.send({ type: "event", event: "text_delta", text: d.text, accumulated: finalText });
          }
        } else if (evt.type === "content_block_stop") {
          if (thinkingChars > 0) {
            process.send({ type: "event", event: "thinking_done", length: thinkingChars });
            thinkingChars = 0;
          }
        }
      } else if (message.type === "assistant" && message.message) {
        for (const block of message.message.content || []) {
          if (block.type === "tool_use") {
            let inputSummary = "";
            if (block.input) {
              if (block.input.file_path) inputSummary = block.input.file_path;
              else if (block.input.command) inputSummary = block.input.command.slice(0, 80);
              else if (block.input.pattern) inputSummary = block.input.pattern;
              else if (block.input.prompt) inputSummary = block.input.prompt.slice(0, 60) + "...";
              else inputSummary = JSON.stringify(block.input).slice(0, 80);
            }
            process.send({ type: "event", event: "tool_use", name: block.name, input: inputSummary });
          }
        }
      } else if (message.type === "user" && message.tool_use_result) {
        const summary = typeof message.tool_use_result === "string"
          ? message.tool_use_result.slice(0, 120)
          : JSON.stringify(message.tool_use_result).slice(0, 120);
        process.send({ type: "event", event: "tool_result", summary });
      } else if (message.type === "result") {
        resultData = message;
        if (message.result) finalText = message.result;
        process.send({
          type: "result",
          sessionId: message.session_id,
          usage: message.usage,
          numTurns: message.num_turns,
        });
      }
    }

    if (resultData && resultData.result) finalText = resultData.result;

    process.send({ type: "done", text: finalText });
  } catch (e) {
    process.send({ type: "error", message: e.message, stderr: e.stderr || "" });
  }
});
