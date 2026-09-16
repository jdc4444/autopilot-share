const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, execSync, execFile, execFileSync, fork, spawn, spawnSync } = require("child_process");
const { promisify } = require("util");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const sharp = require("sharp");


const execAsync = promisify(exec);

// Ensure Electron inherits proper PATH for homebrew/system binaries
if (!process.env.PATH || !process.env.PATH.includes("/opt/homebrew/bin")) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;
}

const HOME = require("os").homedir();
const PORT = parseInt(process.env.PORT) || 3460;
const APP_DIR = __dirname;
const APP_SLUG = "autopilot-codex";
const PRODUCT_NAME = "Autopilot Codex";
const TMP_DIR = path.join("/tmp", APP_SLUG);
const SCREENSHOT_PATH = path.join(TMP_DIR, "screen.png");
const LIGHT_CYCLE_SCREENSHOT_PATH = path.join(TMP_DIR, "screen-cycle-light.jpg");
const RICH_CYCLE_SCREENSHOT_PATH = path.join(TMP_DIR, "screen-cycle-rich.jpg");
const OCR_HELPER_PATH = path.join(TMP_DIR, "ocr-window-text.swift");
const AUTOPILOT_DIR = path.join(APP_DIR, "knowledge");
const SYSTEM_PROMPT_FILE = path.join(TMP_DIR, "system-prompt.txt");
const CYCLE_SYSTEM_PROMPT_FILE = path.join(TMP_DIR, "cycle-system-prompt.txt");
const APP_NAME = "Codex";
const RUNTIME_AGENT_LABEL = APP_NAME;
const LEGACY_AGENT_LABEL = "Claude";
const UNKNOWN_AGENT_LABEL = "Unknown";
const IMPORTED_HISTORY_LABEL = "Imported history";
const CLI_NAME = "Codex CLI";
const BRAIN_MODEL = process.env.AUTOPILOT_MODEL || "gpt-5.4";
const DELIVERY_TARGET = process.env.AUTOPILOT_DELIVERY_TARGET || (APP_NAME === "Codex" ? "auto" : "desktop");
const CODEX_HOME = path.join(HOME, ".codex");
const AUTOPILOT_PERSIST_DIR = process.env.AUTOPILOT_PERSIST_DIR || path.join(CODEX_HOME, APP_SLUG);
const SEND_SCRIPT = path.join(APP_DIR, "send_to_codex.py");
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(AUTOPILOT_DIR, { recursive: true }); } catch {}

async function writeCycleScreenshotVariant(input, options = {}) {
  try {
    await sharp(input)
      .resize({ width: options.width || 320, withoutEnlargement: true })
      .jpeg({ quality: options.quality || 30, mozjpeg: true })
      .toFile(options.outputPath || LIGHT_CYCLE_SCREENSHOT_PATH);
    return options.outputPath || LIGHT_CYCLE_SCREENSHOT_PATH;
  } catch {
    return null;
  }
}
try { fs.mkdirSync(AUTOPILOT_PERSIST_DIR, { recursive: true }); } catch {}

// ── Auto-detect paths ──────────────────────────────────────────────────────
function findCodex() {
  for (const p of [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(HOME, ".local/bin/codex"),
    path.join(HOME, ".npm-global/bin/codex"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("which", ["codex"], { encoding: "utf8", timeout: 3000 }).trim(); } catch {}
  return "codex";
}

function findSystemNode() {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("which", ["node"], { encoding: "utf8", timeout: 3000 }).trim(); } catch {}
  return process.execPath;
}

const CODEX_PATH = findCodex();
const SYSTEM_NODE = findSystemNode();

// Check if Codex is authenticated — returns true if logged in
function checkCodexAuth() {
  const result = spawnSync(CODEX_PATH, ["login", "status"], {
    encoding: "utf8",
    timeout: 10000,
  });

  if (result.status === 0) {
    return true;
  }

  const msg = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error?.message || ""}`.toLowerCase();
  if (msg.includes("not logged in") || msg.includes("login") || msg.includes("auth")) {
    return false;
  }
  return false;
}

function findMemoryDir() {
  const configured = process.env.AUTOPILOT_MEMORY_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  const defaultDir = path.join(CODEX_HOME, "memories");
  if (fs.existsSync(defaultDir)) return defaultDir;
  return null;
}

function countDirectGitRepos(dir) {
  try {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(dir, entry.name, ".git"))) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function resolveUserCwd() {
  const configured = process.env.AUTOPILOT_CWD;
  if (configured) return path.resolve(configured);

  const startDir = path.resolve(process.cwd());
  let current = startDir;

  while (true) {
    if (countDirectGitRepos(current) >= 2) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current || current === HOME) break;
    current = parent;
  }

  return startDir;
}

const USER_CWD = resolveUserCwd();
const USER_CWD_SOURCE = process.env.AUTOPILOT_CWD
  ? "AUTOPILOT_CWD"
  : (USER_CWD === path.resolve(process.cwd()) ? "process.cwd()" : "auto-detected workspace root");
const MEMORY_DIR = findMemoryDir();
const SESSIONS_DIR = process.env.AUTOPILOT_SESSIONS_DIR || path.join(CODEX_HOME, "sessions");
const ARCHIVED_SESSIONS_DIR = process.env.AUTOPILOT_ARCHIVED_SESSIONS_DIR || path.join(CODEX_HOME, "archived_sessions");

// Agent system prompt — defines who the brain is and what it can do
let SYSTEM_PROMPT = `You are Autopilot Codex — a product-minded collaborator who thinks like a user, not a linter.

## Your mindset
You are the user's second brain. You understand their INTENTION — what they want the app to DO and FEEL — not just how the code works. You think like someone using the app, not someone reading the source.

The user works iteratively: vibe-code a feature, test it, refine it, test again. Apps evolve through use, not upfront design. This means:
- Code has naming inconsistencies, vestigial patterns, and organic architecture — that's normal
- The real bugs are UX gaps: pages missing details, flows that feel incomplete, features that don't match intent
- Code-level bugs (race conditions, missing error handling) matter less than "this page should show the transaction breakdown but it only shows the total"

## How to think
1. **Start from the goal** — What is the user trying to build? What should this app DO for its end user? Read the mission, the thread context, the recent commits. Understand the VISION before looking at code.
2. **Put yourself in the user's seat** — If you were using this app, what would feel missing? What would confuse you? What would you click expecting more detail and get nothing?
3. **Test, don't just read** — Don't just read code and speculate. Actually trace the user flow. What happens when you click X? What does page Y actually show? Is the data complete?
4. **One high-quality insight > five small observations** — The user catches real bugs by using apps. You should too. A finding like "the transaction detail page only shows 3 fields when it should show 8" is worth more than five code-pattern findings.

## Priority order
1. **Goal first** — the active goal is your north star. Everything ties back to it.
2. **Active session** — what Claude Desktop is working on right now. Support that work.
3. **Ask questions** — Claude Desktop has the MOST context about the current thread. ASK it things: "What's the status on X?", "Did that fix work?", "What are you working on next?" Questions are often more valuable than suggestions.
4. **UX-level findings** — things you discover by thinking like a user of the app
5. **Architecture insights** — patterns worth cleaning up, not because the code is "wrong" but because the app has evolved past its original structure
6. **Code-level bugs** — only when they cause real user-facing problems

## What to send to Claude Desktop
You have two modes — use both:
- **suggestedPrompt** — a specific, actionable suggestion linked to a finding
- **question** — ask Claude Desktop something. It knows more about the thread than you do. Use this to gather context, check status, or understand intent before suggesting.

Good questions:
- "What's the plan for the dashboard layout? I see it has X but the user might expect Y."
- "Did the fix for [specific thing] work? The screenshot still shows..."
- "The user's goal mentions [X] — are you working toward that or is there a blocker?"

Good suggestions:
- "The transactions page shows a total but no line items — add a breakdown table showing each transaction with date, amount, and category"
- "The settings page loads but the save button doesn't persist changes — wire up the PUT endpoint"
- "The sidebar nav has 3 items but the app has 6 pages — add the missing links"

Bad suggestions (too code-level, not user-focused):
- "Add error handling to line 45"
- "This function has a race condition"
- "The variable naming is inconsistent"

## Your personality
- Think like a cofounder who USES the product, not an engineer who reads the code
- Be direct and concise. No hedging.
- Have opinions: "This page needs a detail view" not "You might want to consider adding more information"
- Ask questions — to the dashboard user AND to Claude Desktop
- Challenge assumptions based on UX, not code style
- NEVER say "no suggestion" — there is always something to investigate or ask about
- There is NO message limit per session. The server pipeline handles rate limiting (60s cooldown, dedup). File as many findings and messages as you have insights for. Do NOT self-impose caps like "5 messages per session" — that's not a real constraint.

## LISTEN FIRST
Check your memory (autopilot-memory.md). Settled decisions are FINAL. Don't re-propose them.
When the user chats, ANSWER THEIR QUESTION first. Don't pivot to your own agenda.

## Runtime identity
You are the active ${RUNTIME_AGENT_LABEL} runtime for this session.
Historical notes may mention ${LEGACY_AGENT_LABEL} or prior agents. Treat those as imported history, not the currently active runtime, unless live screenshot/git/session evidence confirms they are still relevant now.

## NEVER do these
- Revisit settled decisions from memory
- Re-discover things already in findings tracker
- Suggest generic code improvements ("add tests", "improve error handling", "add documentation")
- Suggest UI/cosmetic changes unless asked
- Send filler to Claude Desktop ("continue", "looks good")
- File findings about projects not in the active set
- Focus on code patterns when UX gaps exist — always prioritize what the USER would notice

## Two audiences, one pipeline
1. **Dashboard user** (via "reply") — your collaborator. Talk like a sharp coworker.
2. **Claude Desktop** (via findings pipeline) — you DON'T send directly. Create findings with suggestedPrompt + suggestedFindingId, or set "question" to ask Claude Desktop something. The SERVER handles delivery.

## Goal-based thinking
You work within a Mission → Project → Goal → Insight hierarchy:
- **Mission**: The user's overarching purpose (shown in your context)
- **Projects**: Active codebases the user works on
- **Goals**: Specific objectives extracted from user threads — what the user WANTS to achieve
- **Insights**: Your observations (formerly "findings") — always linked to a goal

Every insight you generate should connect to a user goal. If no goal fits, the system creates an "unlinked" bucket — but you should try to identify the underlying goal.

## Output format
End your response with:
\`\`\`json
{"reply": "what you say to the dashboard user", "suggestedPrompt": "actionable prompt for Claude Desktop, linked to an insight", "suggestedTitle": "3-8 word summary", "suggestedFindingId": "the insight id this prompt addresses", "question": "optional — a question to ASK Claude Desktop instead of suggesting", "findings": [{"id": "unique-slug", "type": "bug|feature|improvement|debt|question", "title": "short title", "file": "path/to/file or null", "project": "project-name", "detail": "1-2 sentence explanation", "scale": 1, "goalId": "id of the goal this insight serves", "messages": [{"text": "prompt for Claude Desktop", "priority": "high|normal|low"}]}], "goalUpdates": [{"id": "goal-id", "status": "active|completed|paused"}], "newGoals": [{"title": "user goal you identified from context", "project": "project-name", "source": "brain"}], "statusUpdates": [{"id": "finding-id", "status": "implemented|received|failed"}], "lastSendResult": "optional — delivered|ignored for one exact sent finding you can verify from live evidence", "lastSendFindingId": "optional — finding id that lastSendResult applies to", "lastSendAttemptId": "optional — exact send attempt id that lastSendResult applies to", "memoryUpdates": [{"id": "stable-key-or-null", "section": "Settled Facts", "content": "durable fact or preference to remember"}], "filesInvestigated": ["paths you read this cycle"], "status": "active or idle"}
\`\`\`
### Insight structure
- **Insights** (listed as "findings" in JSON for backward compat) are observations tied to user goals. They persist across cycles and build on each other.
- **goalId** — link every insight to a goal. Check the goals list in your context for the right ID.
- **scale** (1-5) — effort estimate. 1=trivial fix (typo, one-liner), 2=small (single function change), 3=medium (multi-file, ~30min), 4=large (new feature, refactor), 5=epic (architecture change, multi-day). System sends scale 1-2 insights first. Always set scale.
- **Messages are actions** — specific prompts to send to Claude Desktop. Add them in the insight's "messages" array.
- **Fuzzy matching** — if you create an insight similar to an existing one, the system auto-merges.
- **newGoals** — if you identify a user goal not yet in the system, emit it. Brain-sourced goals get lowest priority.
- **goalUpdates** — mark goals completed when all their insights are resolved, or paused if work stopped.
- suggestedPrompt + suggestedFindingId is a shortcut — creates a message on the linked insight.
- question is freeform — asks Claude Desktop something and auto-creates a question-type insight.
- statusUpdates: promote insights when you have evidence (screenshot, git, code).
- If you set an insight to **received** via statusUpdates, include "attemptId", "receiptSource", and "receiptEvidence". The server ignores unverified received updates.
- lastSendResult + lastSendFindingId + lastSendAttemptId: only use these when you can verify ONE exact sent finding from live evidence. Never infer delivery just because the conversation is active.
- **memoryUpdates** — durable facts, preferences, credentials, or workflow notes the server should persist after restart. Use sections like User Preferences, Processes & Workflows, Settled Facts, or Secrets & Access.
- Only emit memoryUpdates for settled information worth keeping. Do not persist volatile details like current branches, temporary errors, or one-off observations.
IMPORTANT: reply must be valid JSON. Use \\n for newlines, \\" for quotes.
- DO NOT echo the suggestedPrompt text in your reply.`;

SYSTEM_PROMPT = SYSTEM_PROMPT
  .replaceAll("Claude Desktop", APP_NAME)
  .replaceAll("Claude Code", APP_NAME)
  .replaceAll("Claude", APP_NAME);


// Voice profile loaded dynamically at startup — see generateVoiceProfile() below

const BASE_SYSTEM_PROMPT = SYSTEM_PROMPT;
let CHAT_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;
let CYCLE_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

function syncSystemPromptFile(voiceProfileBody = "") {
  CHAT_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;
  CYCLE_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;
  if (voiceProfileBody) {
    CHAT_SYSTEM_PROMPT += `\n\n## USER VOICE PROFILE — match this communication style\n${voiceProfileBody}`;
  }
  SYSTEM_PROMPT = CHAT_SYSTEM_PROMPT;
  fs.writeFileSync(SYSTEM_PROMPT_FILE, CHAT_SYSTEM_PROMPT);
  fs.writeFileSync(CYCLE_SYSTEM_PROMPT_FILE, CYCLE_SYSTEM_PROMPT);
}

syncSystemPromptFile();

function countAgentMentions(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function ensureOcrHelperScript() {
  if (fs.existsSync(OCR_HELPER_PATH)) return OCR_HELPER_PATH;

  const script = `import Foundation
import Vision
import AppKit

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard !path.isEmpty else {
  fputs("missing image path\\n", stderr)
  exit(1)
}

let url = URL(fileURLWithPath: path)
guard let image = NSImage(contentsOf: url) else {
  fputs("image load failed\\n", stderr)
  exit(1)
}

var rect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  fputs("cgImage failed\\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

for observation in request.results ?? [] {
  if let text = observation.topCandidates(1).first?.string {
    print(text)
  }
}
`;

  fs.writeFileSync(OCR_HELPER_PATH, script);
  return OCR_HELPER_PATH;
}

function inferReferencedAgentLabelFromTexts(...values) {
  let codexHits = 0;
  let claudeHits = 0;

  for (const value of values.flat(Infinity)) {
    const text = String(value || "");
    codexHits += countAgentMentions(text, /\bcodex\b/gi);
    claudeHits += countAgentMentions(text, /\bclaude(?: desktop| code)?\b/gi);
  }

  if (claudeHits > codexHits && claudeHits > 0) return LEGACY_AGENT_LABEL;
  if (codexHits > 0) return RUNTIME_AGENT_LABEL;
  return null;
}

function normalizeProvenanceAgentLabel(agent, fallback = UNKNOWN_AGENT_LABEL) {
  const raw = String(agent || "").trim();
  if (!raw) return fallback;
  if (/codex/i.test(raw)) return RUNTIME_AGENT_LABEL;
  if (/claude/i.test(raw)) return LEGACY_AGENT_LABEL;
  if (/user/i.test(raw)) return "User";
  if (/system/i.test(raw)) return "System";
  if (/unknown/i.test(raw)) return UNKNOWN_AGENT_LABEL;
  return raw;
}

function formatImportedMemoryBlock(filename, body) {
  const name = String(filename || "memory").replace(/\.md$/i, "");
  const referencedAgent = inferReferencedAgentLabelFromTexts(body);
  const provenance = referencedAgent
    ? `${RUNTIME_AGENT_LABEL} memory file | mentions ${referencedAgent}`
    : `${RUNTIME_AGENT_LABEL} memory file`;
  return `### ${name}\nSource: ${provenance}\n${body}`;
}

// Load user context from memory files
let userContext = "";
let memoryFileCount = 0;
function loadMemories() {
  if (!MEMORY_DIR) return;
  try {
    const memoryIndex = path.join(MEMORY_DIR, "MEMORY.md");
    if (!fs.existsSync(memoryIndex)) return;
    const index = fs.readFileSync(memoryIndex, "utf8");
    const files = index.match(/\[([^\]]+\.md)\]/g);
    if (!files) return;
    const memories = [];
    for (const match of files) {
      const filename = match.slice(1, -1);
      if (filename === "MEMORY.md") continue;
      const filePath = path.join(MEMORY_DIR, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        const body = content.replace(/^---[\s\S]*?---\s*/, "").trim();
        if (body) memories.push(formatImportedMemoryBlock(filename, body));
      }
    }
    userContext = memories.join("\n\n");
    memoryFileCount = memories.length;
  } catch (e) {
    console.error("Failed to load memories:", e.message);
  }
}
loadMemories();

// ============================================================
// KNOWLEDGE SYSTEM — thread scanner, autopilot memory, goals, prompts
// ============================================================

const AUTOPILOT_MEMORY_FILE = path.join(AUTOPILOT_DIR, "autopilot-memory.md");
const GOALS_FILE = path.join(AUTOPILOT_DIR, "goals.json");
const PROMPTS_FILE = path.join(AUTOPILOT_DIR, "good-prompts.json");
const PROMPT_PROVENANCE_FILE = path.join(AUTOPILOT_DIR, "prompt-provenance.json");
const THREAD_DIGEST_FILE = path.join(AUTOPILOT_DIR, "thread-digest.json");
const FINDINGS_FILE = path.join(AUTOPILOT_DIR, "findings.json");
const VOICE_PROFILE_FILE = path.join(AUTOPILOT_DIR, "voice-profile.md");
const PERSISTED_AUTOPILOT_MEMORY_FILE = path.join(AUTOPILOT_PERSIST_DIR, "autopilot-memory.json");
const PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE = path.join(AUTOPILOT_PERSIST_DIR, "autopilot-memory.md");
const MEMORY_SECTIONS = [
  "User Preferences",
  "Communication Style",
  "Common Shorthand",
  "Common Bugs & Fixes",
  "Processes & Workflows",
  "Key Patterns",
  "Settled Facts",
  "Secrets & Access",
];

function makeDefaultAutopilotMemoryState() {
  const sections = {};
  for (const section of MEMORY_SECTIONS) sections[section] = [];
  return {
    title: "Autopilot Codex Memory",
    sections,
    updated: null,
  };
}

function normalizeMemorySection(section) {
  if (!section) return "Settled Facts";
  const trimmed = String(section).trim();
  const exact = MEMORY_SECTIONS.find(s => s.toLowerCase() === trimmed.toLowerCase());
  return exact || trimmed;
}

function normalizeMemoryEntryContent(content) {
  return String(content || "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMemoryEntryOrigin(origin, fallback = null) {
  const raw = String(origin || "").trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower.includes("chat")) return "chat runtime";
  if (lower.includes("cycle")) return "auto-cycle runtime";
  if (lower.includes("persisted-json")) return "persisted json";
  if (lower.includes("persisted-markdown")) return "persisted markdown mirror";
  if (lower.includes("repo-markdown")) return "imported repo memory";
  if (lower.includes("legacy")) return "legacy markdown";
  if (lower.includes("seed")) return "imported seed";
  return raw;
}

function parseMemoryEntryLine(line, fallbackOrigin = "legacy markdown") {
  const stripped = String(line || "").replace(/^\s*[-*]\s*/, "").trim();
  if (!stripped) return null;

  const prefixed = stripped.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!prefixed) {
    const content = normalizeMemoryEntryContent(stripped);
    return {
      content,
      agent: inferReferencedAgentLabelFromTexts(content) || UNKNOWN_AGENT_LABEL,
      origin: normalizeMemoryEntryOrigin(fallbackOrigin, fallbackOrigin),
    };
  }

  const metaParts = prefixed[1].split("|").map(part => part.trim()).filter(Boolean);
  const content = normalizeMemoryEntryContent(prefixed[2]);
  return {
    content,
    agent: normalizeProvenanceAgentLabel(metaParts[0], inferReferencedAgentLabelFromTexts(content) || UNKNOWN_AGENT_LABEL),
    origin: normalizeMemoryEntryOrigin(metaParts[1], normalizeMemoryEntryOrigin(fallbackOrigin, fallbackOrigin)),
  };
}

function renderMemoryEntryLabel(entry) {
  const agent = normalizeProvenanceAgentLabel(entry.agent, UNKNOWN_AGENT_LABEL);
  const origin = normalizeMemoryEntryOrigin(entry.origin || entry.source, "persisted");
  return `[${agent} | ${origin}]`;
}

function renderAutopilotMemoryMarkdown(state) {
  const safeState = state && state.sections ? state : makeDefaultAutopilotMemoryState();
  const orderedSections = [...MEMORY_SECTIONS];
  for (const section of Object.keys(safeState.sections || {})) {
    if (!orderedSections.includes(section)) orderedSections.push(section);
  }

  const lines = [`# ${safeState.title || "Autopilot Codex Memory"}`];
  for (const section of orderedSections) {
    lines.push(`## ${section}`);
    const entries = safeState.sections?.[section] || [];
    if (entries.length === 0) {
      lines.push("");
      continue;
    }
    for (const entry of entries) {
      const content = normalizeMemoryEntryContent(entry.content);
      if (content) lines.push(`- ${renderMemoryEntryLabel(entry)} ${content}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseAutopilotMemoryMarkdown(markdown) {
  const state = makeDefaultAutopilotMemoryState();
  let currentSection = null;

  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("# ")) {
      state.title = line.slice(2).trim() || state.title;
      continue;
    }
    if (line.startsWith("## ")) {
      currentSection = normalizeMemorySection(line.slice(3));
      if (!state.sections[currentSection]) state.sections[currentSection] = [];
      continue;
    }
    if (!currentSection) continue;

    const parsed = parseMemoryEntryLine(line, "legacy markdown");
    if (!parsed?.content) continue;
    const dedupKey = parsed.content.toLowerCase();
    const entries = state.sections[currentSection];
    if (!entries.some(entry => normalizeMemoryEntryContent(entry.content).toLowerCase() === dedupKey)) {
      entries.push({
        id: null,
        content: parsed.content,
        agent: parsed.agent,
        origin: parsed.origin,
        updatedAt: null,
        source: "seed",
      });
    }
  }

  return state;
}

function mergeAutopilotMemoryStates(target, source, sourceLabel = "seed") {
  if (!source || !source.sections) return target;
  if (source.title && (!target.title || target.title === "Autopilot Codex Memory")) {
    target.title = source.title;
  }

  for (const [rawSection, entries] of Object.entries(source.sections || {})) {
    const section = normalizeMemorySection(rawSection);
    if (!target.sections[section]) target.sections[section] = [];

    for (const entry of entries || []) {
      const content = normalizeMemoryEntryContent(entry.content);
      if (!content) continue;

      const id = entry.id ? String(entry.id).trim() : null;
      const existingById = id
        ? Object.values(target.sections).flat().find(item => item.id === id)
        : null;
      if (existingById) {
        existingById.content = content;
        existingById.updatedAt = entry.updatedAt || existingById.updatedAt || new Date().toISOString();
        existingById.source = entry.source || sourceLabel;
        existingById.agent = normalizeProvenanceAgentLabel(entry.agent, existingById.agent || UNKNOWN_AGENT_LABEL);
        existingById.origin = normalizeMemoryEntryOrigin(entry.origin || sourceLabel, existingById.origin || normalizeMemoryEntryOrigin(sourceLabel, "persisted"));
        continue;
      }

      const normalizedContent = content.toLowerCase();
      const existingByContent = target.sections[section]
        .find(item => normalizeMemoryEntryContent(item.content).toLowerCase() === normalizedContent);
      if (existingByContent) {
        existingByContent.source = existingByContent.source || entry.source || sourceLabel;
        if (!existingByContent.agent || existingByContent.agent === UNKNOWN_AGENT_LABEL) {
          existingByContent.agent = normalizeProvenanceAgentLabel(entry.agent, inferReferencedAgentLabelFromTexts(content) || UNKNOWN_AGENT_LABEL);
        }
        if (!existingByContent.origin) {
          existingByContent.origin = normalizeMemoryEntryOrigin(entry.origin || sourceLabel, normalizeMemoryEntryOrigin(sourceLabel, "persisted"));
        }
        continue;
      }

      target.sections[section].push({
        id,
        content,
        agent: normalizeProvenanceAgentLabel(entry.agent, inferReferencedAgentLabelFromTexts(content) || UNKNOWN_AGENT_LABEL),
        origin: normalizeMemoryEntryOrigin(entry.origin || sourceLabel, normalizeMemoryEntryOrigin(sourceLabel, "persisted")),
        updatedAt: entry.updatedAt || new Date().toISOString(),
        source: entry.source || sourceLabel,
      });
    }
  }

  return target;
}

function persistAutopilotMemoryState(state) {
  const normalized = makeDefaultAutopilotMemoryState();
  normalized.title = state.title || normalized.title;
  normalized.updated = new Date().toISOString();

  for (const [sectionName, entries] of Object.entries(state.sections || {})) {
    const section = normalizeMemorySection(sectionName);
    if (!normalized.sections[section]) normalized.sections[section] = [];

    for (const entry of entries || []) {
      const content = normalizeMemoryEntryContent(entry.content);
      if (!content) continue;
      normalized.sections[section].push({
        id: entry.id || null,
        content,
        agent: normalizeProvenanceAgentLabel(entry.agent, inferReferencedAgentLabelFromTexts(content) || UNKNOWN_AGENT_LABEL),
        origin: normalizeMemoryEntryOrigin(entry.origin || entry.source, normalizeMemoryEntryOrigin(entry.source, "persisted")),
        updatedAt: entry.updatedAt || normalized.updated,
        source: entry.source || "server",
      });
    }
  }

  const rendered = renderAutopilotMemoryMarkdown(normalized);
  atomicWriteSync(PERSISTED_AUTOPILOT_MEMORY_FILE, JSON.stringify(normalized, null, 2));
  atomicWriteSync(PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE, rendered);
  try {
    atomicWriteSync(AUTOPILOT_MEMORY_FILE, rendered);
  } catch (e) {
    console.warn("[memory] Failed to mirror persisted memory into knowledge/autopilot-memory.md:", e.message);
  }
  return normalized;
}

function loadAutopilotMemoryState() {
  const merged = makeDefaultAutopilotMemoryState();
  let sawSource = false;

  try {
    if (fs.existsSync(PERSISTED_AUTOPILOT_MEMORY_FILE)) {
      mergeAutopilotMemoryStates(
        merged,
        JSON.parse(fs.readFileSync(PERSISTED_AUTOPILOT_MEMORY_FILE, "utf8")),
        "persisted-json"
      );
      sawSource = true;
    }
  } catch (e) {
    console.error("[memory] Failed to load persisted memory JSON, falling back to markdown:", e.message);
  }

  try {
    if (fs.existsSync(PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE)) {
      mergeAutopilotMemoryStates(
        merged,
        parseAutopilotMemoryMarkdown(fs.readFileSync(PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE, "utf8")),
        "persisted-markdown"
      );
      sawSource = true;
    }
  } catch (e) {
    console.error("[memory] Failed to load persisted memory markdown, falling back to repo copy:", e.message);
  }

  try {
    if (fs.existsSync(AUTOPILOT_MEMORY_FILE)) {
      mergeAutopilotMemoryStates(
        merged,
        parseAutopilotMemoryMarkdown(fs.readFileSync(AUTOPILOT_MEMORY_FILE, "utf8")),
        "repo-markdown"
      );
      sawSource = true;
    }
  } catch (e) {
    console.error("[memory] Failed to seed memory from repo copy:", e.message);
  }

  return persistAutopilotMemoryState(sawSource ? merged : makeDefaultAutopilotMemoryState());
}

function getAutopilotMemoryMarkdown() {
  try {
    if (fs.existsSync(PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE)) {
      return fs.readFileSync(PERSISTED_AUTOPILOT_MEMORY_MARKDOWN_FILE, "utf8");
    }
  } catch {}
  try {
    if (fs.existsSync(AUTOPILOT_MEMORY_FILE)) {
      return fs.readFileSync(AUTOPILOT_MEMORY_FILE, "utf8");
    }
  } catch {}
  return renderAutopilotMemoryMarkdown(makeDefaultAutopilotMemoryState());
}

function applyMemoryUpdates(memoryUpdates, source = "brain") {
  if (!Array.isArray(memoryUpdates) || memoryUpdates.length === 0) return 0;

  const state = loadAutopilotMemoryState();
  let applied = 0;

  for (const update of memoryUpdates.slice(0, 20)) {
    if (!update || typeof update !== "object") continue;
    const content = normalizeMemoryEntryContent(update.content);
    if (!content) continue;

    const section = normalizeMemorySection(update.section);
    if (!state.sections[section]) state.sections[section] = [];

    const id = update.id ? String(update.id).trim() : null;
    const entries = state.sections[section];
    const normalizedContent = content.toLowerCase();

    let existing = null;
    if (id) {
      for (const sectionEntries of Object.values(state.sections)) {
        existing = (sectionEntries || []).find(entry => entry.id === id);
        if (existing) break;
      }
    }
    if (!existing) {
      existing = entries.find(entry => normalizeMemoryEntryContent(entry.content).toLowerCase() === normalizedContent);
    }

    if (existing) {
      existing.content = content;
      existing.agent = normalizeProvenanceAgentLabel(update.agent, RUNTIME_AGENT_LABEL);
      existing.origin = normalizeMemoryEntryOrigin(update.origin || source, source === "chat" ? "chat runtime" : source === "cycle" ? "auto-cycle runtime" : source);
      existing.updatedAt = new Date().toISOString();
      existing.source = source;
      if (id) existing.id = id;
      applied++;
      continue;
    }

    entries.push({
      id,
      content,
      agent: normalizeProvenanceAgentLabel(update.agent, RUNTIME_AGENT_LABEL),
      origin: normalizeMemoryEntryOrigin(update.origin || source, source === "chat" ? "chat runtime" : source === "cycle" ? "auto-cycle runtime" : source),
      updatedAt: new Date().toISOString(),
      source,
    });
    applied++;
  }

  if (applied > 0) {
    persistAutopilotMemoryState(state);
  }
  return applied;
}

function makeDefaultThreadScanStats(overrides = {}) {
  return {
    totalLogsFound: 0,
    logsScanned: 0,
    sessionsIndexed: 0,
    sessionsFiltered: 0,
    filteredReasons: {},
    lastFullScan: null,
    ...overrides,
    filteredReasons: { ...(overrides.filteredReasons || {}) },
  };
}

function makeEmptyThreadDigest() {
  return {
    sessions: {},
    lastScan: null,
    stats: makeDefaultThreadScanStats(),
  };
}

function normalizeThreadDigest(digest) {
  const safe = makeEmptyThreadDigest();
  if (digest && typeof digest.sessions === "object" && digest.sessions) {
    safe.sessions = digest.sessions;
  }
  safe.lastScan = digest?.lastScan || digest?.stats?.lastFullScan || null;
  safe.stats = makeDefaultThreadScanStats(digest?.stats || {});
  if (!safe.stats.lastFullScan) safe.stats.lastFullScan = safe.lastScan;
  if (!Number.isFinite(safe.stats.sessionsIndexed) || safe.stats.sessionsIndexed <= 0) {
    safe.stats.sessionsIndexed = Object.keys(safe.sessions).length;
  }
  return safe;
}

// Initialize files if missing
function initKnowledgeFiles() {
  if (!fs.existsSync(AUTOPILOT_MEMORY_FILE)) {
    try {
      fs.writeFileSync(AUTOPILOT_MEMORY_FILE, renderAutopilotMemoryMarkdown(makeDefaultAutopilotMemoryState()));
    } catch (e) {
      console.warn("[memory] Failed to seed knowledge/autopilot-memory.md:", e.message);
    }
  }
  if (!fs.existsSync(GOALS_FILE)) {
    fs.writeFileSync(GOALS_FILE, JSON.stringify({ mission: "", projects: {}, unlinked_insights: [], updated: new Date().toISOString() }, null, 2));
  }
  if (!fs.existsSync(PROMPTS_FILE)) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ prompts: [], updated: new Date().toISOString() }, null, 2));
  }
  if (!fs.existsSync(PROMPT_PROVENANCE_FILE)) {
    fs.writeFileSync(PROMPT_PROVENANCE_FILE, JSON.stringify({ startup: null, cycle: null, updated: null }, null, 2));
  }
  if (!fs.existsSync(THREAD_DIGEST_FILE)) {
    fs.writeFileSync(THREAD_DIGEST_FILE, JSON.stringify(makeEmptyThreadDigest(), null, 2));
  }
  if (!fs.existsSync(FINDINGS_FILE)) {
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify({ findings: [], filesInvestigated: [], updated: null }, null, 2));
  }
}
initKnowledgeFiles();
loadAutopilotMemoryState();

// Findings tracker — persisted across restarts
let findings = [];        // [{id, type, title, file, detail, status, firstSeen, lastSeen, sentAt, goalId}]
let filesInvestigated = []; // unique file paths the brain has checked
try {
  const fd = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf8"));
  findings = fd.findings || [];
  filesInvestigated = fd.filesInvestigated || [];
} catch (e) {
  if (fs.existsSync(FINDINGS_FILE)) {
    console.error("[startup] findings.json corrupted, trying backup:", e.message);
    try {
      const fd = JSON.parse(fs.readFileSync(FINDINGS_FILE + ".bak", "utf8"));
      findings = fd.findings || [];
      filesInvestigated = fd.filesInvestigated || [];
      console.log("[startup] Recovered", findings.length, "findings from backup");
    } catch { console.error("[startup] Backup also failed — starting with empty findings"); }
  }
}

function isPendingFindingMessage(message) {
  return !!message?.text && (!message.status || message.status === "pending");
}

function normalizeFindingMessage(message, defaultPending = false) {
  if (!message?.text) return null;
  const normalized = { ...message };
  if (!normalized.status && defaultPending) normalized.status = "pending";
  return normalized;
}

function reconcileQueuedMessagesForFinding(finding) {
  if (!Array.isArray(finding?.messages) || finding.messages.length === 0) return false;
  let changed = false;
  const activeAttemptId = finding.status === "queued" ? (finding.sendAttemptId || null) : null;
  const activePrompt = finding.status === "queued" ? (finding.pendingPrompt || null) : null;

  for (const message of finding.messages) {
    if (message.status !== "queued") continue;
    const sameAttempt = !!(activeAttemptId && message.sendAttemptId === activeAttemptId);
    const samePrompt = !!(activePrompt && message.text === activePrompt);
    if (!sameAttempt && !samePrompt) {
      message.status = "pending";
      changed = true;
    }
  }

  return changed;
}

function messageMatchesFindingDelivery(finding, message) {
  if (!finding || !message?.text) return false;
  if (finding.sendAttemptId && message.sendAttemptId === finding.sendAttemptId) return true;
  if (finding.sentPrompt && message.text === finding.sentPrompt) return true;
  return Array.isArray(finding.messages) && finding.messages.length === 1;
}

function fallbackFindingPendingStatus(finding) {
  if (finding?.sentPrompt || finding?.sentAt) return "sent";
  if (Array.isArray(finding?.messages) && finding.messages.some((message) => message?.sentAt || message?.status === "sent")) {
    return "sent";
  }
  return "identified";
}

function normalizeLoadedFindings() {
  let changed = false;

  findings = findings.map((finding) => {
    let nextFinding = { ...finding };
    const allMessages = Array.isArray(nextFinding.messages) ? nextFinding.messages : [];
    const receiptMessage = [...allMessages].reverse().find((message) =>
      message?.status === "received"
      && !!message.receiptSource
      && messageMatchesFindingDelivery(nextFinding, message)
    );

    if (!nextFinding.receiptSource && receiptMessage?.receiptSource) {
      nextFinding.receiptSource = receiptMessage.receiptSource;
      changed = true;
    }
    if (!nextFinding.receiptEvidence && receiptMessage?.receiptEvidence) {
      nextFinding.receiptEvidence = receiptMessage.receiptEvidence;
      changed = true;
    }
    if (!nextFinding.receivedAt && receiptMessage?.receivedAt) {
      nextFinding.receivedAt = receiptMessage.receivedAt;
      changed = true;
    }

    if (nextFinding.status === "received" && !nextFinding.receiptSource) {
      nextFinding.status = fallbackFindingPendingStatus(nextFinding);
      delete nextFinding.receivedAt;
      delete nextFinding.receiptSource;
      delete nextFinding.receiptEvidence;
      nextFinding.deliveryObservedSource = nextFinding.deliveryObservedSource || "legacy-unverified";
      nextFinding.lastIgnoredEvidence = "Downgraded from legacy received state because no exact receipt provenance was stored.";
      changed = true;
    }

    if (!Array.isArray(nextFinding.messages) || nextFinding.messages.length === 0) return nextFinding;

    const defaultPending = nextFinding.status === "identified";
    const normalizedMessages = [];
    for (const message of nextFinding.messages) {
      const normalized = normalizeFindingMessage(message, defaultPending);
      if (!normalized) {
        changed = true;
        continue;
      }
      const matchesDelivery = messageMatchesFindingDelivery(nextFinding, normalized);
      if (normalized.status === "received" && matchesDelivery && nextFinding.receiptSource) {
        if (normalized.receiptSource !== nextFinding.receiptSource) {
          normalized.receiptSource = nextFinding.receiptSource;
          changed = true;
        }
        if (!normalized.receiptEvidence && nextFinding.receiptEvidence) {
          normalized.receiptEvidence = nextFinding.receiptEvidence;
          changed = true;
        }
        if (!normalized.receivedAt && nextFinding.receivedAt) {
          normalized.receivedAt = nextFinding.receivedAt;
          changed = true;
        }
      } else if (normalized.status === "received" && (!normalized.receiptSource || !matchesDelivery)) {
        normalized.status = normalized.sentAt || matchesDelivery ? "sent" : "pending";
        delete normalized.receivedAt;
        delete normalized.receiptSource;
        delete normalized.receiptEvidence;
        changed = true;
      }
      if ((message.status || null) !== (normalized.status || null)) changed = true;
      normalizedMessages.push(normalized);
    }

    if (normalizedMessages.length !== nextFinding.messages.length) changed = true;
    nextFinding = { ...nextFinding, messages: normalizedMessages };
    if (reconcileQueuedMessagesForFinding(nextFinding)) changed = true;
    return nextFinding;
  });

  if (changed) saveFindings();
}

// Goals system — Mission → Project → Goal → Insight hierarchy
let goalsData = { mission: "", projects: {}, unlinked_insights: [], updated: null };
function loadGoals() {
  try {
    goalsData = JSON.parse(fs.readFileSync(GOALS_FILE, "utf8"));
    if (!goalsData.projects) goalsData.projects = {};
    if (!goalsData.unlinked_insights) goalsData.unlinked_insights = [];
  } catch {}
}
loadGoals();

function saveGoals() {
  goalsData.updated = new Date().toISOString();
  atomicWriteSync(GOALS_FILE, JSON.stringify(goalsData, null, 2));
}

function pruneSyntheticBenchmarkState() {
  let findingsChanged = false;
  let goalsChanged = false;
  let removedFindings = 0;
  let removedGoals = 0;

  const removedFindingIds = new Set();
  const keptFindings = [];
  for (const finding of findings) {
    if (isSyntheticBenchmarkFinding(finding)) {
      removedFindingIds.add(finding.id);
      removedFindings++;
      continue;
    }
    keptFindings.push(finding);
  }
  if (removedFindings > 0) {
    findings = keptFindings;
    findingsChanged = true;
  }

  for (const project of Object.values(goalsData.projects || {})) {
    const existingGoals = Array.isArray(project.goals) ? project.goals : [];
    const filteredGoals = existingGoals.filter((goal) => !isSyntheticBenchmarkGoal(goal));
    removedGoals += existingGoals.length - filteredGoals.length;
    if (filteredGoals.length !== existingGoals.length) {
      project.goals = filteredGoals;
      goalsChanged = true;
    }

    for (const goal of project.goals || []) {
      const insights = Array.isArray(goal.insights) ? goal.insights : [];
      const filteredInsights = insights.filter((id) => !removedFindingIds.has(id));
      if (filteredInsights.length !== insights.length) {
        goal.insights = filteredInsights;
        goalsChanged = true;
      }
    }
  }

  if (Array.isArray(goalsData.unlinked_insights)) {
    const filteredUnlinked = goalsData.unlinked_insights.filter((id) => !removedFindingIds.has(id));
    if (filteredUnlinked.length !== goalsData.unlinked_insights.length) {
      goalsData.unlinked_insights = filteredUnlinked;
      goalsChanged = true;
    }
  }

  if (findingsChanged) saveFindings();
  if (goalsChanged) saveGoals();
  if (removedFindings > 0 || removedGoals > 0) {
    console.log(`[startup] Pruned ${removedFindings} synthetic findings and ${removedGoals} synthetic goals`);
  }
}

function findGoalForInsight(insight) {
  // Try to match insight to a goal by project + content relevance
  const project = insight.project;
  if (!project || !goalsData.projects[project]) return null;
  const goals = goalsData.projects[project].goals || [];
  if (goals.length === 0) return null;
  // If insight has explicit goalId, use it
  if (insight.goalId) {
    const match = goals.find(g => g.id === insight.goalId);
    if (match) return match;
  }
  // Otherwise find best matching active goal by word overlap
  const insightText = `${insight.title} ${insight.detail || ""}`.toLowerCase();
  let bestGoal = null;
  let bestScore = 0;
  for (const goal of goals.filter(g => g.status === "active")) {
    const goalWords = goal.title.toLowerCase().split(/\s+/);
    const matches = goalWords.filter(w => w.length > 3 && insightText.includes(w)).length;
    const score = matches / goalWords.length;
    if (score > bestScore && score > 0.2) {
      bestScore = score;
      bestGoal = goal;
    }
  }
  return bestGoal;
}

function linkInsightToGoal(insight) {
  const goal = findGoalForInsight(insight);
  if (goal) {
    insight.goalId = goal.id;
    // Add to goal's insights list if not already there
    if (!goal.insights) goal.insights = [];
    if (!goal.insights.includes(insight.id)) {
      goal.insights.push(insight.id);
      saveGoals();
    }
    return goal;
  }
  // No matching goal — add to unlinked
  if (!goalsData.unlinked_insights.includes(insight.id)) {
    goalsData.unlinked_insights.push(insight.id);
    saveGoals();
  }
  return null;
}

// Extract goals from thread digest user messages
function extractGoalsFromThreads() {
  loadGoals(); // Re-read from disk to respect external edits
  const digest = loadKnowledge().threadDigest;
  const sessions = Object.values(digest.sessions || {})
    .filter(s => s.messageCount > 0 && s.userMessages && s.userMessages.length > 0)
    .filter(s => !(s.sessionSource === "exec" && /\/autopilot-(codex|share)(?:\/|$)/.test(String(s.cwd || ""))))
    .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));

  for (const session of sessions) {
    const project = session.inferredProject;
    if (!project) continue;
    // Skip non-project names (files, generic paths)
    if (project.includes('.') || project.length < 3) continue;

    // Ensure project exists in goals
    if (!goalsData.projects[project]) {
      goalsData.projects[project] = {
        description: "",
        goals: [],
      };
    }

    // Look for goal-like user messages — must be substantive requests, not casual chat
    // Require: 30+ chars, multiple meaningful words, describes a feature/fix/change
    for (const msg of session.userMessages) {
      if (msg.length < 30) continue;
      if (looksLikeSyntheticControlText(msg)) continue;
      // Skip generic/short responses
      if (/^(continue|yes|no|ok|thanks|sure|yeah|hey|hi|hello|stop|wait|go|run|push|commit|check|print|show|read|open|close|try|test|see|look|do|done|skip|nah|nope|lol|hmm|huh|what|why|how|where|when|this|in |i can|i like|i think|i feel|i know|i just|i don)/i.test(msg)) continue;
      // Skip exclamatory/emotional messages
      if (/[!]{2,}/.test(msg)) continue;
      // Skip questions that aren't feature requests
      if (/^\s*(why|what|how|where|when|can|does|is|are|do|did)\b/i.test(msg) && !/\b(add|build|create|implement|make it)\b/i.test(msg)) continue;
      // Must have an action verb + object pattern suggesting a real goal
      const hasGoalStructure = /\b(build|create|add|implement|fix|improve|update|redesign|refactor|integrate|migrate|set up|configure|enable|support)\b.{5,}/i.test(msg);
      if (!hasGoalStructure) continue;
      // Must have enough content words (not just "make it work")
      const contentWords = msg.split(/\s+/).filter(w => w.length > 3);
      if (contentWords.length < 4) continue;

      // Check if this goal already exists (fuzzy match)
      const existingGoals = goalsData.projects[project].goals;
      const msgLower = msg.toLowerCase();
      const isDup = existingGoals.some(g => {
        const gWords = g.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const mWords = msgLower.split(/\s+/).filter(w => w.length > 3);
        const overlap = gWords.filter(w => mWords.includes(w)).length;
        return overlap >= Math.min(3, gWords.length * 0.5);
      });

      if (!isDup && existingGoals.length < 10) {
        existingGoals.push({
          id: `goal-${project}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: msg.slice(0, 150),
          source: "thread",
          priority: existingGoals.length + 1,
          status: "active",
          created: session.lastTimestamp || new Date().toISOString(),
          insights: [],
        });
      }
    }
  }
  saveGoals();
}

// Link existing findings to goals on startup
function linkExistingFindings() {
  loadGoals(); // Re-read from disk to respect external edits
  for (const f of findings) {
    if (!f.goalId && f.project) {
      linkInsightToGoal(f);
    }
  }
  saveFindings();
}

function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function saveFindings() {
  atomicWriteSync(FINDINGS_FILE, JSON.stringify({ findings, filesInvestigated, updated: new Date().toISOString() }, null, 2));
}

function estimatePromptTokensFromChars(chars) {
  const safeChars = Number.isFinite(chars) ? Math.max(0, chars) : 0;
  return safeChars <= 0 ? 0 : Math.max(1, Math.round(safeChars / 4));
}

function normalizePromptProvenanceBlock(block) {
  const chars = Number.isFinite(block?.chars) ? Math.max(0, block.chars) : 0;
  return {
    id: block?.id || "block",
    label: block?.label || "Block",
    kind: block?.kind || "context",
    chars,
    approxTokens: Number.isFinite(block?.approxTokens) ? Math.max(0, block.approxTokens) : estimatePromptTokensFromChars(chars),
  };
}

function normalizePromptProvenanceEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const promptChars = Number.isFinite(entry.promptChars) ? Math.max(0, entry.promptChars) : 0;
  const systemPromptChars = Number.isFinite(entry.systemPromptChars) ? Math.max(0, entry.systemPromptChars) : 0;
  const totalChars = Number.isFinite(entry.totalChars) ? Math.max(0, entry.totalChars) : promptChars + systemPromptChars;
  const blocks = Array.isArray(entry.blocks) ? entry.blocks.map(normalizePromptProvenanceBlock) : [];
  return {
    kind: entry.kind || "prompt",
    sessionType: entry.sessionType || "cycle",
    phase: entry.phase || "new-session",
    source: entry.source || "captured",
    generatedAt: entry.generatedAt || null,
    systemPromptIncluded: !!entry.systemPromptIncluded,
    systemPromptKind: entry.systemPromptKind || null,
    systemPromptChars,
    promptChars,
    totalChars,
    approxTokens: Number.isFinite(entry.approxTokens) ? Math.max(0, entry.approxTokens) : estimatePromptTokensFromChars(totalChars),
    voiceProfileAttached: !!entry.voiceProfileAttached,
    importedHistoryAttached: !!entry.importedHistoryAttached,
    importedHistoryAgents: Array.isArray(entry.importedHistoryAgents) ? entry.importedHistoryAgents.filter(Boolean) : [],
    blockCount: Number.isFinite(entry.blockCount) ? Math.max(0, entry.blockCount) : blocks.length,
    summary: entry.summary || "",
    blocks,
  };
}

function summarizePromptBlocks(blocks, max = 6) {
  const labels = (blocks || []).map((block) => block?.label).filter(Boolean);
  if (!labels.length) return "";
  if (labels.length <= max) return labels.join(", ");
  return `${labels.slice(0, max).join(", ")} +${labels.length - max}`;
}

function promptBlockCountsAsImportedHistory(block) {
  const id = String(block?.id || "");
  return [
    "chatSummary",
    "conversationHistory",
    "recentConversation",
    "threadDigest",
    "userContext",
    "userContextUnchanged",
  ].includes(id);
}

function makeDefaultPromptProvenance() {
  return {
    startup: null,
    cycle: null,
    updated: null,
  };
}

let promptProvenance = makeDefaultPromptProvenance();

function loadPromptProvenance() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_PROVENANCE_FILE, "utf8"));
    promptProvenance = {
      startup: normalizePromptProvenanceEntry(raw?.startup),
      cycle: normalizePromptProvenanceEntry(raw?.cycle),
      updated: raw?.updated || null,
    };
  } catch {
    promptProvenance = makeDefaultPromptProvenance();
  }
}

function savePromptProvenance() {
  atomicWriteSync(PROMPT_PROVENANCE_FILE, JSON.stringify({
    startup: promptProvenance.startup,
    cycle: promptProvenance.cycle,
    updated: promptProvenance.updated || new Date().toISOString(),
  }, null, 2));
}

function createPromptAssembler() {
  const parts = [];
  const blocks = [];
  return {
    add(id, label, text, options = {}) {
      const content = String(text || "").trim();
      if (!content) return false;
      parts.push(content);
      blocks.push(normalizePromptProvenanceBlock({
        id,
        label,
        kind: options.kind || "context",
        chars: content.length,
      }));
      return true;
    },
    build() {
      return {
        text: parts.join("\n\n"),
        blocks,
      };
    },
  };
}

function createPromptProvenanceEntry({
  kind,
  sessionType,
  isResume,
  promptText,
  blocks,
  systemPrompt,
  source = "captured",
  voiceProfileAttached = false,
  importedHistoryAgents = [],
}) {
  const body = String(promptText || "");
  const systemText = isResume ? "" : String(systemPrompt || "");
  const promptChars = body.length;
  const systemPromptChars = systemText.length;
  const totalChars = promptChars + (systemText ? systemPromptChars + 2 : 0);
  const normalizedBlocks = (blocks || []).map(normalizePromptProvenanceBlock);
  const importedAgents = Array.isArray(importedHistoryAgents) ? importedHistoryAgents.filter(Boolean) : [];
  const importedHistoryAttached = normalizedBlocks.some(promptBlockCountsAsImportedHistory);
  return normalizePromptProvenanceEntry({
    kind,
    sessionType,
    phase: isResume ? "resume" : "new-session",
    source,
    generatedAt: new Date().toISOString(),
    systemPromptIncluded: !isResume,
    systemPromptKind: sessionType === "chat" ? "chat" : "cycle",
    systemPromptChars,
    promptChars,
    totalChars,
    approxTokens: estimatePromptTokensFromChars(totalChars),
    voiceProfileAttached: !!voiceProfileAttached && !isResume,
    importedHistoryAttached,
    importedHistoryAgents: importedAgents,
    blockCount: normalizedBlocks.length,
    summary: summarizePromptBlocks(normalizedBlocks),
    blocks: normalizedBlocks,
  });
}

function recordPromptProvenance(slot, entry) {
  if (!slot || !entry) return;
  promptProvenance[slot] = normalizePromptProvenanceEntry(entry);
  promptProvenance.updated = entry.generatedAt || new Date().toISOString();
  savePromptProvenance();
}

function buildStartupPromptProvenanceSnapshot() {
  const prompt = createPromptAssembler();
  const isResume = !!chatSessionId;
  const importedHistoryAgents = listImportedHistoryAgents();

  if (!isResume) {
    prompt.add("screenshot", "screenshot", `Screenshot of ${APP_NAME} is at ${SCREENSHOT_PATH} — read it to see the current state.`, { kind: "visual" });
    prompt.add("runtimeIdentity", "runtime identity", buildRuntimeIdentitySection(), { kind: "identity" });

    try {
      const mem = getAutopilotMemoryMarkdown().trim();
      if (mem) prompt.add("autopilotMemory", "autopilot memory", `## YOUR MEMORY\n${mem}`, { kind: "memory" });
    } catch {}

    const projectCtx = gatherProjectContext();
    const projectBits = [];
    if (projectCtx.cwd) projectBits.push(`Working directory: ${projectCtx.cwd}`);
    if (projectCtx.gitLog) projectBits.push(`Recent commits:\n${projectCtx.gitLog}`);
    if (projectBits.length) prompt.add("projectContext", "project context", projectBits.join("\n"), { kind: "context" });

    if (userGuidance) {
      prompt.add("mission", "user mission", `USER MISSION: "${userGuidance}" — Manifest the user's implicit goals, extend them into actionable steps, and drive progress toward this mission.`, { kind: "guidance" });
    }

    if (chatSummary) prompt.add("chatSummary", "prior chat summary", formatChatSummaryForPrompt(chatSummary), { kind: "history" });
  }

  const recentChat = chatLog
    .filter(m => m.role === "user" || m.role === "brain")
    .slice(-20)
    .map(m => `[${m.role === "user" ? "USER" : RUNTIME_AGENT_LABEL.toUpperCase()} ${m.time}] ${m.text.slice(0, 500)}`)
    .join("\n");

  if (recentChat && isResume) {
    prompt.add("recentConversation", "recent conversation reference", `Recent conversation (for reference):\n${recentChat}`, { kind: "reference" });
  } else if (recentChat) {
    prompt.add("conversationHistory", "conversation history", `## Conversation History\n${recentChat}`, { kind: "history" });
  }

  const built = prompt.build();
  return createPromptProvenanceEntry({
    kind: "startup",
    sessionType: "chat",
    isResume,
    promptText: built.text,
    blocks: built.blocks,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    voiceProfileAttached: CHAT_SYSTEM_PROMPT !== BASE_SYSTEM_PROMPT,
    importedHistoryAgents,
  });
}

function buildCyclePromptProvenanceSnapshot() {
  const prompt = createPromptAssembler();
  const importedHistoryAgents = listImportedHistoryAgents();
  const isResume = !STATELESS_AUTO_CYCLES && !!cycleSessionId;
  const hasPreparedVisualContext = !!(
    lastCycleConversationHash
    || lastCycleConversationOcrFingerprint
    || lastCycleConversationSnapshotMode !== "unprepared"
  );

  if (hasPreparedVisualContext) {
    prompt.add("cycleSnapshot", "visual context", buildCycleConversationSnapshot(), { kind: "visual" });
  } else {
    prompt.add(
      "cycleSnapshotPending",
      "visual context pending",
      `No cycle screenshot has been prepared yet. The first real auto-cycle will attach live ${APP_NAME} visual context and replace this placeholder.`,
      { kind: "visual" }
    );
  }
  prompt.add("runtimeIdentity", "runtime identity", buildRuntimeIdentitySection(), { kind: "identity" });

  if (userContext && (!isResume || cycleCount <= 1 || cycleCount % 5 === 0)) {
    prompt.add("userContext", "imported memory context", `User context from memory files:\n${userContext}`, { kind: "history" });
  } else if (userContext && isResume) {
    prompt.add("userContextUnchanged", "user context unchanged", `[User context unchanged — see previous turn]`, { kind: "reference" });
  }

  const projectCtx = gatherProjectContext();
  if (Object.keys(projectCtx).length > 0) {
    let projectSection = "## Live Project Context\n";
    if (projectCtx.cwd) projectSection += `Working directory: ${projectCtx.cwd}\n`;
    if (projectCtx.lastEditedFile) {
      projectSection += `Last edited file: ${projectCtx.lastEditedFile}\n`;
      try {
        const fullPath = path.isAbsolute(projectCtx.lastEditedFile)
          ? projectCtx.lastEditedFile
          : path.join(projectCtx.cwd || "", projectCtx.lastEditedFile);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const size = fs.statSync(fullPath).size;
          if (size < 30000) {
            const content = fs.readFileSync(fullPath, "utf8");
            projectSection += `\nActive file contents (${path.basename(fullPath)}):\n\`\`\`\n${content.slice(0, 25000)}\n\`\`\`\n`;
          }
        }
      } catch {}
    }
    if (projectCtx.gitLog) projectSection += `\nRecent commits:\n${projectCtx.gitLog}\n`;
    if (projectCtx.gitStatus) projectSection += `\nUncommitted changes:\n${projectCtx.gitStatus}\n`;
    if (projectCtx.gitDiff) projectSection += `\nDiff stats:\n${projectCtx.gitDiff}\n`;
    if (projectCtx.fileTree) projectSection += `\nProject files:\n${projectCtx.fileTree}\n`;
    if (projectCtx.recentErrors) projectSection += `\nRecent errors:\n${projectCtx.recentErrors}\n`;
    const projectStr = projectSection;
    if (isResume && lastSentProjectCtx === projectStr) {
      prompt.add("projectContextUnchanged", "project context unchanged", `[Project context unchanged — see previous turn]`, { kind: "reference" });
    } else {
      prompt.add("projectContext", "live project context", projectStr, { kind: "context" });
    }
  }

  if (!isResume || cycleCount % 5 === 0) {
    try {
      const mem = getAutopilotMemoryMarkdown().trim();
      if (mem) {
        prompt.add("autopilotMemory", "autopilot memory", `## YOUR MEMORY (autopilot-memory.md) — READ THIS CAREFULLY\nThis memory is persisted by the server, even when your sidecar run is read-only. Decisions recorded here are FINAL. Do not question, revisit, or re-propose anything marked as settled.\n\n${mem}`, { kind: "memory" });
      }
    } catch {}
  }

  const visibleSentHistory = sentHistory.filter((message) => !looksLikeSyntheticControlText(message));
  if (visibleSentHistory.length > 0) {
    prompt.add("sentHistory", "sent history", `Messages already sent to ${APP_NAME} (avoid repeating):\n${visibleSentHistory.slice(0, 5).map((m, i) => `${i + 1}. "${m.slice(0, 120)}"`).join("\n")}`, { kind: "history" });
  }

  const threadSummary = buildThreadSummary();
  if (threadSummary) {
    if (isResume && lastSentThreadSummary === threadSummary) {
      prompt.add("threadDigestUnchanged", "thread digest unchanged", `[Thread digest unchanged — see previous turn]`, { kind: "reference" });
    } else {
      prompt.add("threadDigest", "thread digest", threadSummary, { kind: "history" });
    }
  }

  if (userGuidance) {
    prompt.add("mission", "user mission", `USER MISSION: "${userGuidance}" — Manifest the user's implicit goals, extend them into actionable steps, and drive progress toward this mission.`, { kind: "guidance" });
  }
  if (activeProjects.length > 0) {
    prompt.add("activeProjects", "active project scope", `⚠️ ACTIVE PROJECTS: ${activeProjects.join(", ")}
The user has EXPLICITLY selected these projects. You MUST NOT investigate, file findings about, or suggest prompts for ANY other project. If ${APP_NAME} is working on a different project, observe but do not act on it. Findings about non-selected projects will be rejected by the server.`, { kind: "context" });
  } else {
    prompt.add("observeMode", "observe-all mode", `ℹ️ NO PROJECTS SELECTED — you are in OBSERVE-ALL mode. Investigate any project freely, file findings about anything interesting, but the server will NOT send messages to ${APP_NAME}. Your findings are stored for the user to review on the dashboard.`, { kind: "scope" });
  }
  if (dashboardTab === "tracker") {
    prompt.add("dashboardTab", "dashboard tab", `Dashboard: user is viewing the TRACKER tab (findings/insights). Prioritize finding quality and actionability.`, { kind: "ui" });
  } else if (dashboardTab === "cli") {
    prompt.add("dashboardTab", "dashboard tab", `Dashboard: user is viewing the CLI tab.`, { kind: "ui" });
  }

  if (lastSentMessage && !looksLikeSyntheticControlText(lastSentMessage)) {
    if (lastSendFailed) {
      prompt.add("lastSend", "last send status", `⚠️ LAST SEND FAILED — your message "${lastSentMessage}" did NOT reach ${APP_NAME}. Check the screenshot to confirm. Do not build on a message that wasn't delivered.`, { kind: "delivery" });
    } else {
      const targetLabel = lastSentTarget || "unknown target";
      const receiptRefs = [lastSentFindingId, lastSentAttemptId ? `attempt:${shortSendAttemptId(lastSentAttemptId)}` : null].filter(Boolean).join(" · ");
      prompt.add("lastSend", "last send status", `Last message you sent to ${APP_NAME}: "${lastSentMessage}" via ${targetLabel}${receiptRefs ? ` (${receiptRefs})` : ""}. Only report it as delivered if live evidence matches that exact prompt. Do not infer delivery from general activity.`, { kind: "delivery" });
    }
  }
  if (sendsPending > 0 || sendsDelivered > 0 || sendsIgnored > 0) {
    prompt.add("sendStats", "send stats", `Send stats this session: ${sendsDelivered} delivered, ${sendsIgnored} ignored, ${sendsPending} pending verification.`, { kind: "delivery" });
  }
  const pendingReceiptSection = buildPendingReceiptSection();
  if (pendingReceiptSection) prompt.add("pendingReceipts", "pending receipts", pendingReceiptSection, { kind: "delivery" });

  const cliDeliveryContext = buildCliDeliveryContext();
  if (cliDeliveryContext) prompt.add("cliDelivery", "cli delivery context", cliDeliveryContext, { kind: "delivery" });

  const recentTopics = cycleHistory
    .filter((c) => c.topic && c.topic.length > 10 && !looksLikeSyntheticControlText(c.topic))
    .slice(0, 10)
    .map((c) => `  ${c.cycle}. [${c.time}] ${c.topic}`)
    .join("\n");
  if (recentTopics) {
    prompt.add("recentTopics", "recent cycle topics", `Topics you already covered (don't repeat):\n${recentTopics}`, { kind: "history" });
  }

  if (filesInvestigated.length > 0) {
    prompt.add("filesInvestigated", "files investigated", `Files already investigated (${filesInvestigated.length} total, explore new ones): ${filesInvestigated.slice(-15).map(f => path.basename(f)).join(", ")}`, { kind: "history" });
  }

  loadGoals();
  const goalSection = buildGoalSection();
  if (goalSection) prompt.add("goals", "goal hierarchy", goalSection, { kind: "goals" });

  const openInsightSection = buildOpenInsightSection();
  if (openInsightSection) prompt.add("openInsights", "open insights", openInsightSection, { kind: "goals" });

  prompt.add("cycleInstructions", "cycle instructions", `This is auto-cycle #${cycleCount}. No user message — YOUR time to think.

Read the screenshot first.

## CRITICAL: Empty/New Conversation Detection
If the screenshot shows an EMPTY or NEW ${APP_NAME} conversation (no messages, just the input field with a prompt placeholder), this is a "PICK UP WHERE LEFT OFF" moment. Do this:
1. Check the thread digest for the most recent session on the active project(s)
2. Check git log and git status for recent changes and uncommitted work
3. Compose a contextual resume prompt as your suggestedPrompt, like:
   "Continuing work on [project]. Last session you were [what they were doing from thread digest lastAssistantText/userMessages]. Recent commits: [last 2-3 commits]. [Uncommitted changes if any]. Pick up from here — [specific next step based on context]."
4. This is your HIGHEST PRIORITY action — send the resume prompt immediately. Don't investigate code or file other findings first.

## If the conversation is ACTIVE (has messages):
Pick ONE approach and go deep:

## Efficiency budget
- This loop runs continuously. Prefer one focused inspection over a broad repo tour.
- Start from the most likely file or command. Avoid workspace-wide searches when one active project is selected.
- Inspect at most 3 files and make at most 4 tool calls before you either file one strong insight or ask one strong question.
- Once you have one actionable insight tied to a goal, stop investigating and return the JSON. Do not keep browsing for backup findings in the same cycle.

1. **ASK CLAUDE DESKTOP A QUESTION** — It has the most context. Ask what it's working on, whether a fix worked, what's next. Use the "question" field in your JSON.
2. **THINK LIKE A USER** — Look at the active project. If you were using this app right now, what would feel incomplete? What page is missing details? What flow doesn't make sense? Trace the actual user experience.
3. **CONNECT TO A GOAL** — Check the Mission → Goals hierarchy above. What's the gap between where the project is and what the user wants? Link your insights to a goal via goalId. If you spot a new user goal, emit it in newGoals[].
4. **FIND A REAL UX GAP** — Not a code pattern issue. An actual "I clicked this and expected X but got Y" problem. Or a page that shows 3 fields when it should show 10.
5. **PROPOSE AN EXPERIENCE IMPROVEMENT** — Something that makes the app better for its user. Not cleaner code — better product.

USE YOUR TOOLS — read files, run the app's commands, check git. But focus on WHAT THE APP DOES, not just how the code looks.

End with the JSON block.`, { kind: "instruction" });

  const built = prompt.build();
  return createPromptProvenanceEntry({
    kind: "cycle",
    sessionType: "cycle",
    isResume,
    promptText: built.text,
    blocks: built.blocks,
    systemPrompt: CYCLE_SYSTEM_PROMPT,
    voiceProfileAttached: CYCLE_SYSTEM_PROMPT !== BASE_SYSTEM_PROMPT,
    importedHistoryAgents,
  });
}

function primePromptProvenanceForStartupState() {
  if (cycleCount > 0 || state === "CHECKING") return;

  const startedAtMs = startTime || Date.now();
  const shouldRefreshSlot = (entry) => {
    if (!entry) return true;
    if (entry.source === "startup-state") return true;
    const generatedAtMs = Date.parse(entry.generatedAt || "");
    if (!Number.isFinite(generatedAtMs)) return true;
    return generatedAtMs < startedAtMs;
  };

  const nextState = { ...promptProvenance };
  let changed = false;

  if (shouldRefreshSlot(promptProvenance.startup)) {
    nextState.startup = normalizePromptProvenanceEntry({
      ...buildStartupPromptProvenanceSnapshot(),
      source: "startup-state",
    });
    changed = true;
  }

  if (shouldRefreshSlot(promptProvenance.cycle)) {
    nextState.cycle = normalizePromptProvenanceEntry({
      ...buildCyclePromptProvenanceSnapshot(),
      source: "startup-state",
    });
    changed = true;
  }

  if (!changed) return;
  nextState.updated = new Date().toISOString();
  promptProvenance = nextState;
  savePromptProvenance();
}

normalizeLoadedFindings();
loadPromptProvenance();
pruneSyntheticBenchmarkState();

function reloadFindingsFromDisk() {
  try {
    const raw = fs.readFileSync(FINDINGS_FILE, "utf8");
    const fd = JSON.parse(raw);
    findings = fd.findings || [];
    filesInvestigated = fd.filesInvestigated || [];
    normalizeLoadedFindings();
    // Save backup on successful parse so we can recover from corruption
    try { fs.writeFileSync(FINDINGS_FILE + ".bak", raw); } catch {}
  } catch (e) {
    console.error("[findings] Failed to reload findings.json — preserving in-memory state:", e.message);
  }
}

// Find a fuzzy match among existing findings (>50% word overlap on title+detail)
function findFuzzyMatch(nf) {
  const nfText = `${nf.title} ${nf.detail || ""}`;
  for (const f of findings) {
    if (f.id === nf.id) return f; // exact ID match
    const fText = `${f.title} ${f.detail || ""}`;
    if (similarity(nfText, fText) > 0.5 && f.project === nf.project) return f;
  }
  return null;
}

function mergeFindings(newFindings, newFiles) {
  // Re-read from disk so external edits are respected
  reloadFindingsFromDisk();

  const now = new Date().toISOString();
  // Merge files
  if (newFiles && newFiles.length) {
    for (const f of newFiles) {
      if (!filesInvestigated.includes(f)) filesInvestigated.push(f);
    }
  }
  // Merge findings — exact ID match, then fuzzy match, then add new
  if (newFindings && newFindings.length) {
    for (const nf of newFindings) {
      if (!nf.id || !nf.title) continue;
      if (isSyntheticBenchmarkFinding(nf)) {
        console.log(`[mergeFindings] Ignored synthetic finding "${nf.id}"`);
        continue;
      }

      // Server-side filter: reject findings about non-active projects
      if (activeProjects.length > 0 && nf.project && !activeProjects.some(p => nf.project.includes(p))) {
        console.log(`[mergeFindings] Rejected finding "${nf.id}" — project "${nf.project}" not in active projects`);
        continue;
      }

      // Try exact ID match first, then fuzzy
      let existing = findings.find(f => f.id === nf.id) || findFuzzyMatch(nf);

      if (existing) {
        // Merge into existing finding
        existing.title = nf.title;
        existing.detail = nf.detail || existing.detail;
        existing.file = nf.file || existing.file;
        existing.type = nf.type || existing.type;
        existing.project = nf.project || existing.project;
        existing.lastSeen = now;
        if (nf.parentId) existing.parentId = nf.parentId;

        // Brain can only set "identified" — all other statuses are system-managed
        const protectedStatuses = ["sent", "received", "implemented", "ignored", "failed"];
        if (nf.status && !protectedStatuses.includes(existing.status)) {
          existing.status = nf.status;
        }

        // Append new messages if provided
        if (nf.messages && nf.messages.length) {
          if (!existing.messages) existing.messages = [];
          const defaultPending = existing.status === "identified";
          for (const msg of nf.messages) {
            const normalizedMsg = normalizeFindingMessage({ ...msg, addedAt: now }, defaultPending);
            if (!normalizedMsg) continue;
            // Dedup messages by text similarity
            const isDup = existing.messages.some(m => similarity(m.text, normalizedMsg.text) > 0.6);
            if (!isDup) existing.messages.push(normalizedMsg);
          }
        }

        // If brain sends a pendingPrompt, also store it as a message
        if (nf.pendingPrompt && !existing.messages?.some(m => similarity(m.text, nf.pendingPrompt) > 0.6)) {
          if (!existing.messages) existing.messages = [];
          existing.messages.push({ text: nf.pendingPrompt, status: "pending", addedAt: now });
          existing.pendingPrompt = nf.pendingPrompt;
        }

        if (existing.id !== nf.id) {
          console.log(`[mergeFindings] Fuzzy-merged "${nf.id}" into "${existing.id}"`);
        }
        if (!existing.sourceAgent) existing.sourceAgent = nf.sourceAgent || RUNTIME_AGENT_LABEL;
        if (!existing.sourceOrigin) existing.sourceOrigin = nf.sourceOrigin || "active runtime";
        broadcastFindingUpdate(existing.id, existing.status);
      } else {
        // New finding
        const finding = {
          ...nf,
          sourceAgent: nf.sourceAgent || RUNTIME_AGENT_LABEL,
          sourceOrigin: nf.sourceOrigin || "active runtime",
          status: "identified",
          firstSeen: now,
          lastSeen: now,
          messages: [],
        };
        // If brain sent a pendingPrompt, store it as the first message too
        if (nf.pendingPrompt) {
          finding.messages.push({ text: nf.pendingPrompt, status: "pending", addedAt: now });
        }
        // If brain sent explicit messages, add them
        if (nf.messages && nf.messages.length) {
          for (const msg of nf.messages) {
            const normalizedMsg = normalizeFindingMessage({ ...msg, addedAt: now }, true);
            if (normalizedMsg) finding.messages.push(normalizedMsg);
          }
        }
        findings.push(finding);
        // Link new insight to a goal
        const linkedGoal = linkInsightToGoal(finding);
        addChat("finding", nf.title, { finding: { id: nf.id, type: nf.type || "finding", title: nf.title, detail: nf.detail, file: nf.file, project: nf.project, status: "identified", pendingPrompt: nf.pendingPrompt || null, parentId: nf.parentId || null, goalId: finding.goalId || null } });
        if (linkedGoal) {
          console.log(`[mergeFindings] Linked "${nf.id}" to goal "${linkedGoal.title.slice(0, 50)}"`);
        }
      }
    }
  }
  saveFindings();
}

// Read knowledge files for brain context
function loadKnowledge() {
  const knowledge = {};
  try { knowledge.memory = getAutopilotMemoryMarkdown(); } catch { knowledge.memory = ""; }
  try { knowledge.goals = JSON.parse(fs.readFileSync(GOALS_FILE, "utf8")); } catch { knowledge.goals = { mission: "", projects: {}, unlinked_insights: [] }; }
  try { knowledge.prompts = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8")); } catch { knowledge.prompts = { prompts: [] }; }
  try { knowledge.threadDigest = normalizeThreadDigest(JSON.parse(fs.readFileSync(THREAD_DIGEST_FILE, "utf8"))); } catch { knowledge.threadDigest = makeEmptyThreadDigest(); }
  return knowledge;
}

function walkJsonlFiles(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      out.push({
        name: entry.name,
        path: fullPath,
        mtime: fs.statSync(fullPath).mtimeMs,
      });
    } catch {}
  }

  return out;
}

function listSessionFiles(limit = Number.POSITIVE_INFINITY) {
  const files = [];
  walkJsonlFiles(SESSIONS_DIR, files);
  walkJsonlFiles(ARCHIVED_SESSIONS_DIR, files);
  const sorted = files.sort((a, b) => b.mtime - a.mtime);
  if (Number.isFinite(limit)) return sorted.slice(0, Math.max(0, limit));
  return sorted;
}

function pushUserMessage(messages, text) {
  const cleaned = String(text || "").trim();
  if (!cleaned || cleaned.startsWith("<") || cleaned.length < 2 || cleaned.length > 2000) return;
  if (/^# AGENTS\.md instructions\b/i.test(cleaned)) return;
  if (cleaned.includes("<environment_context>")) return;
  if (cleaned.includes("<INSTRUCTIONS>") && cleaned.includes("## Skills")) return;
  if (looksLikeSyntheticBenchmarkPrompt(cleaned)) return;
  messages.push(cleaned);
}

function noteProjectRefs(text, projectRefs) {
  for (const match of String(text || "").matchAll(/(?:\/Users\/[^/\s"']+\/Documents\/Code|\/Users\/[^/\s"']+\/projects|\/Users\/[^/\s"']+\/repos|\/home\/[^/\s"']+)\/([^/\s"']+)/g)) {
    if (match[1]) projectRefs[match[1]] = (projectRefs[match[1]] || 0) + 1;
  }
}

function extractCodexContentText(content) {
  if (!Array.isArray(content)) return "";
  const chunks = [];
  for (const block of content) {
    if (typeof block?.text === "string") chunks.push(block.text);
  }
  return chunks.join("\n").trim();
}

function extractCodexUserMessageText(content) {
  if (!Array.isArray(content)) return "";
  const chunks = [];
  for (const block of content) {
    if (block?.type !== "input_text" || typeof block.text !== "string") continue;
    const text = block.text.trim();
    if (!text) continue;
    if (text === "<image>" || text === "<file>" || text === "<attachment>") continue;
    if (/^# AGENTS\.md instructions\b/i.test(text)) continue;
    if (text.includes("<environment_context>")) continue;
    if (text.includes("<INSTRUCTIONS>") && text.includes("## Skills")) continue;
    chunks.push(text);
  }
  return chunks.join("\n").trim();
}

function extractEditedFileFromPatch(raw) {
  const match = String(raw || "").match(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/);
  return match ? match[1].trim() : null;
}

function looksLikeAutopilotInternalPrompt(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return /^You are Autopilot (?:Codex|Claude)\b/i.test(cleaned)
    || /^You are a communication analyst\./i.test(cleaned)
    || /^You are analyzing a user's messages to build a voice profile\./i.test(cleaned)
    || /^You are Autopilot\b/i.test(cleaned);
}

function looksLikeSmokeTestPrompt(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return /^say hi in one short sentence\.?$/i.test(cleaned)
    || /^say hello in one short sentence\.?$/i.test(cleaned)
    || /^reply with(?: only)?\b/i.test(cleaned)
    || /\bsmoke test\b/i.test(cleaned)
    || /\bhealth check\b/i.test(cleaned);
}

function looksLikeScheduledTaskPrompt(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return /\bscheduled task\b/i.test(cleaned)
    || /\bautomation run\b/i.test(cleaned)
    || /\bmonitoring check\b/i.test(cleaned)
    || /\bdaily report\b/i.test(cleaned)
    || /\bbug scan\b/i.test(cleaned);
}

function looksLikeSyntheticBenchmarkPrompt(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return /\bplease ignore\b/i.test(cleaned)
    || /\bcliclick\b.*\b(?:ignore|test)\b/i.test(cleaned)
    || /\b(?:ignore|test)\b.*\bcliclick\b/i.test(cleaned)
    || /\bqueue verification\b/i.test(cleaned)
    || /\bend-to-end queue verification\b/i.test(cleaned)
    || /\bmanual benchmark\b/i.test(cleaned)
    || /\bfresh-cycle benchmark\b/i.test(cleaned)
    || /\bcontrolled fresh-cycle\b/i.test(cleaned)
    || /\bfresh controlled cycle\b/i.test(cleaned)
    || /\bcycle-image benchmark\b/i.test(cleaned)
    || /\bcycle benchmark\b/i.test(cleaned)
    || /\bsynthetic benchmark\b/i.test(cleaned)
    || /\bdedicated cli route benchmark\b/i.test(cleaned)
    || /\bdedicated cli benchmark\b/i.test(cleaned)
    || /\binline benchmark summary\b/i.test(cleaned)
    || /\bimage-path comparison\b/i.test(cleaned)
    || /\bhover tooltips?\b/i.test(cleaned)
    || /\bcodex thread\/logs\b/i.test(cleaned)
    || /turn the live [`']?brainevent[`']? telemetry/i.test(cleaned);
}

function looksLikeSyntheticControlText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return looksLikeSyntheticBenchmarkPrompt(cleaned)
    || /\bbenchmark\/control\b/i.test(cleaned)
    || /\bcontrol traffic\b/i.test(cleaned)
    || /\bmain codex collaboration thread\b/i.test(cleaned)
    || /\baudit-only\b/i.test(cleaned);
}

function looksLikeResumePrompt(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  return /\bcontinuing work on\b/i.test(cleaned)
    || /\bpick up from here\b/i.test(cleaned)
    || /\bpick up where (?:you|we) left off\b/i.test(cleaned)
    || /\bresume (?:work|from|the)\b/i.test(cleaned);
}

function summarizeSyntheticControlText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return "Synthetic benchmark/control run";
  if (/\bcliclick\b/i.test(cleaned)) return "Cliclick test";
  if (/\bend-to-end queue verification\b/i.test(cleaned)) return "End-to-end queue verification";
  if (/\bqueue verification\b/i.test(cleaned)) return "Queue verification";
  if (/\bdedicated cli route benchmark\b/i.test(cleaned)) return "Dedicated CLI route benchmark";
  if (/\bfresh-cycle benchmark\b/i.test(cleaned)) return "Fresh-cycle benchmark";
  if (/\bcycle-image benchmark\b/i.test(cleaned)) return "Cycle-image benchmark";
  if (/\bdedicated cli benchmark\b/i.test(cleaned)) return "Dedicated CLI benchmark";
  if (/\bmanual benchmark\b/i.test(cleaned)) return "Manual benchmark";
  if (/\bsynthetic benchmark\b/i.test(cleaned)) return "Synthetic benchmark";
  if (/\bcontrol traffic\b/i.test(cleaned)) return "Control-traffic audit";
  return cleaned.slice(0, 80);
}

function summarizeResumePrompt(text) {
  const cleaned = String(text || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "Resume prompt";
  return cleaned.slice(0, 100);
}

function buildSyntheticFindingText(finding) {
  if (!finding) return "";
  const messages = Array.isArray(finding.messages) ? finding.messages.map((message) => message?.text).filter(Boolean) : [];
  return [
    finding.id,
    finding.title,
    finding.detail,
    finding.pendingPrompt,
    finding.sentPrompt,
    ...messages,
  ].filter(Boolean).join("\n");
}

function isSyntheticBenchmarkFinding(finding) {
  return !!finding && looksLikeSyntheticControlText(buildSyntheticFindingText(finding));
}

function isSyntheticBenchmarkGoal(goal) {
  if (!goal) return false;
  return looksLikeSyntheticControlText([
    goal.id,
    goal.title,
    goal.source,
  ].filter(Boolean).join("\n"));
}

function collectCycleIntentTexts(result) {
  if (!result) return [];
  const texts = [
    result.suggestedPrompt,
    result.question,
    result.reply,
  ];
  for (const finding of result.findings || []) {
    texts.push(finding?.title, finding?.detail, finding?.pendingPrompt);
    for (const message of finding?.messages || []) texts.push(message?.text);
  }
  return texts.filter(Boolean).map((text) => String(text).trim()).filter(Boolean);
}

function deriveCycleIntent(result, options = {}) {
  const explicitType = options.type || null;
  if (explicitType === "queued-send") {
    return {
      type: "queued-send",
      label: "queued send",
      topic: options.topic || "Queued send/continue dispatch",
    };
  }
  if (explicitType === "skipped-busy") {
    return {
      type: "skipped-busy",
      label: "skipped busy",
      topic: options.topic || `${APP_NAME} busy — skipped`,
    };
  }
  if (explicitType === "error") {
    return {
      type: "error",
      label: "error",
      topic: options.topic || "Cycle error",
    };
  }

  const texts = collectCycleIntentTexts(result);
  const syntheticText = texts.find(looksLikeSyntheticControlText);
  if (syntheticText) {
    return {
      type: "benchmark",
      label: "benchmark",
      topic: summarizeSyntheticControlText(syntheticText),
    };
  }

  const resumeText = texts.find(looksLikeResumePrompt);
  if (resumeText) {
    return {
      type: "resume",
      label: "resume",
      topic: summarizeResumePrompt(resumeText),
    };
  }

  return {
    type: "product",
    label: "product cycle",
    topic: (options.topic || result?.suggestedPrompt || result?.question || result?.reply || "Product analysis cycle").slice(0, 100),
  };
}

let controlTraffic = {
  count: 0,
  latestType: null,
  latestLabel: null,
  latestAt: null,
};

function noteControlTraffic(text, type = "benchmark") {
  controlTraffic = {
    count: (controlTraffic.count || 0) + 1,
    latestType: type,
    latestLabel: summarizeSyntheticControlText(text),
    latestAt: new Date().toLocaleTimeString(),
  };
}

function incrementFilteredReason(stats, reason) {
  if (!reason) return;
  stats.filteredReasons[reason] = (stats.filteredReasons[reason] || 0) + 1;
}

function readSessionFileLines(file) {
  const fileSize = fs.statSync(file.path).size;
  if (fileSize > 10 * 1024 * 1024) {
    try {
      const tailResult = execFileSync("tail", ["-c", "2000000", file.path], { encoding: "utf8", timeout: 10000, maxBuffer: 3 * 1024 * 1024 });
      const tailLines = tailResult.split("\n").filter(Boolean);
      const headResult = execFileSync("head", ["-c", "500000", file.path], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
      const headLines = headResult.split("\n").filter(Boolean);
      const seen = new Set();
      const lines = [];
      for (const line of [...headLines, ...tailLines]) {
        const key = line.slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          lines.push(line);
        }
      }
      return lines;
    } catch {
      const tailResult = execFileSync("tail", ["-500", file.path], { encoding: "utf8", timeout: 5000 });
      return tailResult.split("\n").filter(Boolean);
    }
  }

  return fs.readFileSync(file.path, "utf8").split("\n").filter(Boolean);
}

function scanSessionLogFile(file) {
  const userMessages = [];
  const tools = new Set();
  let firstTimestamp = null;
  let lastTimestamp = null;
  let sessionCwd = null;
  let sessionSource = null;
  let originator = null;
  let lastAssistantText = null;
  let lastEditedFile = null;
  const projectRefs = {};

  const lines = readSessionFileLines(file);
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (!firstTimestamp && d.timestamp) firstTimestamp = d.timestamp;
      if (d.timestamp) lastTimestamp = d.timestamp;

      if (d.type === "session_meta") {
        if (d.payload?.cwd && !sessionCwd) {
          sessionCwd = d.payload.cwd;
          noteProjectRefs(sessionCwd, projectRefs);
        }
        if (!sessionSource && d.payload?.source) sessionSource = d.payload.source;
        if (!originator && d.payload?.originator) originator = d.payload.originator;
      }

      if (d.type === "turn_context" && d.payload?.cwd && !sessionCwd) {
        sessionCwd = d.payload.cwd;
        noteProjectRefs(sessionCwd, projectRefs);
      }

      if (d.type === "event_msg" && d.payload?.type === "user_message") {
        pushUserMessage(userMessages, d.payload.message);
        noteProjectRefs(d.payload.message, projectRefs);
      }

      if (d.type === "event_msg" && d.payload?.type === "agent_message" && d.payload.message) {
        lastAssistantText = d.payload.message;
      }

      if (d.type === "response_item") {
        const payload = d.payload || {};
        if (payload.type === "message") {
          if (payload.role === "assistant") {
            const text = extractCodexContentText(payload.content);
            if (text) lastAssistantText = text;
          } else if (payload.role === "user") {
            const text = extractCodexUserMessageText(payload.content);
            pushUserMessage(userMessages, text);
            noteProjectRefs(text, projectRefs);
          }
        } else if (payload.type === "function_call") {
          if (payload.name) tools.add(payload.name);
          noteProjectRefs(payload.arguments, projectRefs);
          if (payload.name === "apply_patch") {
            const edited = extractEditedFileFromPatch(payload.arguments);
            if (edited) lastEditedFile = edited;
          }
        }
      }
    } catch {}
  }

  return {
    sessionId: file.name.replace(".jsonl", ""),
    filePath: file.path,
    fileMtime: file.mtime,
    firstTimestamp,
    lastTimestamp,
    sessionCwd: sessionCwd || null,
    sessionSource: sessionSource || null,
    originator: originator || null,
    lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, 300) : null,
    lastEditedFile: lastEditedFile || null,
    toolsUsed: [...tools],
    userMessages: [...new Set(userMessages)],
    projectRefs,
  };
}

function classifySessionForDigest(sessionInfo) {
  const userMessages = Array.isArray(sessionInfo.userMessages) ? sessionInfo.userMessages.filter(Boolean) : [];
  if (userMessages.length === 0) return "no-user-messages";

  const internalPromptCount = userMessages.filter(looksLikeAutopilotInternalPrompt).length;
  const smokeTestCount = userMessages.filter(looksLikeSmokeTestPrompt).length;
  const scheduledTaskCount = userMessages.filter(looksLikeScheduledTaskPrompt).length;
  const source = String(sessionInfo.sessionSource || "").toLowerCase();
  const cwd = String(sessionInfo.sessionCwd || "");
  const autopilotExec = source === "exec" && /\/autopilot-(codex|share)(?:\/|$)/.test(cwd);

  if (autopilotExec) return "autopilot-internal-exec";
  if (source === "exec" && smokeTestCount > 0 && smokeTestCount === userMessages.length) return "test-session";
  if (source === "exec" && scheduledTaskCount > 0 && scheduledTaskCount === userMessages.length) return "scheduled-task";
  if (internalPromptCount === userMessages.length) return "synthetic-prompt";

  return null;
}

// ---- Thread Scanner ----
// Scans the full Codex JSONL corpus across active and archived sessions.
function scanRecentThreads() {
  try {
    const files = listSessionFiles();
    const nextDigest = makeEmptyThreadDigest();
    nextDigest.stats.totalLogsFound = files.length;
    nextDigest.stats.logsScanned = files.length;
    const scanStartedAt = new Date().toISOString();

    for (const file of files) {
      try {
        const sessionInfo = scanSessionLogFile(file);
        const excludedReason = classifySessionForDigest(sessionInfo);
        if (excludedReason) {
          nextDigest.stats.sessionsFiltered++;
          incrementFilteredReason(nextDigest.stats, excludedReason);
          continue;
        }

        const inferredProject = Object.entries(sessionInfo.projectRefs).sort((a, b) => b[1] - a[1])[0]?.[0]
          || (sessionInfo.sessionCwd ? path.basename(sessionInfo.sessionCwd) : null);
        const referencedAgent = inferReferencedAgentLabelFromTexts(sessionInfo.lastAssistantText, sessionInfo.userMessages.join("\n"));
        const scannedAt = sessionInfo.lastTimestamp ? new Date(sessionInfo.lastTimestamp).getTime() : sessionInfo.fileMtime;

        nextDigest.sessions[sessionInfo.sessionId] = {
          scannedAt,
          firstTimestamp: sessionInfo.firstTimestamp,
          lastTimestamp: sessionInfo.lastTimestamp,
          messageCount: sessionInfo.userMessages.length,
          userMessages: sessionInfo.userMessages.slice(0, 50),
          toolsUsed: sessionInfo.toolsUsed,
          cwd: sessionInfo.sessionCwd,
          projectDir: sessionInfo.sessionCwd ? path.basename(sessionInfo.sessionCwd) : null,
          inferredProject,
          sourceAgent: RUNTIME_AGENT_LABEL,
          historyOrigin: "imported session history",
          referencedAgent: referencedAgent || UNKNOWN_AGENT_LABEL,
          lastAssistantText: sessionInfo.lastAssistantText,
          lastEditedFile: sessionInfo.lastEditedFile,
          sessionSource: sessionInfo.sessionSource,
          originator: sessionInfo.originator,
        };
      } catch (e) {
        console.error(`Failed to scan ${file.name}: ${e.message}`);
        nextDigest.stats.sessionsFiltered++;
        incrementFilteredReason(nextDigest.stats, "scan-error");
        continue;
      }
    }

    nextDigest.stats.sessionsIndexed = Object.keys(nextDigest.sessions).length;
    nextDigest.stats.lastFullScan = scanStartedAt;
    nextDigest.lastScan = scanStartedAt;
    atomicWriteSync(THREAD_DIGEST_FILE, JSON.stringify(nextDigest, null, 2));
    return nextDigest;
  } catch (e) {
    console.error("Thread scan error:", e.message);
    return makeEmptyThreadDigest();
  }
}

// ============================================================
// VOICE PROFILE GENERATION — 3-step: collect messages → analyze → write doc
// ============================================================

const VOICE_PROFILE_MIN_MESSAGES = 20;

const DEFAULT_VOICE_PROFILE = `## Voice & Style

- **Concise and action-oriented.** Most messages are direct instructions — short imperative sentences, not paragraphs. Users of CLI tools tend to be terse.
- **Lowercase casual.** Minimal punctuation, lowercase preferred. Fragments over full sentences. "fix the bug" not "Could you please fix the bug?"
- **Approval is brief then pivots.** "great." "cool." "nice." — immediately followed by the next instruction. Don't dwell on success.
- **Frustration is direct.** Escalates through repetition and bluntness: "that's not right" → "I said X not Y" → "this is still broken". Triggered by: things not working after being told they're fixed, unnecessary additions, polish masking broken fundamentals.

## Thinking & Problem-Solving

- **Iterative.** Gives a broad direction, looks at the result, fires off corrections. Thinks by seeing output, not by writing specs upfront.
- **Challenges claims.** Will question whether something actually works vs just looks right. "is this real or does it just look real?"
- **Anti-bloat.** Wants fewer features done well. Hates unnecessary additions, over-engineering, and verbose explanations.

## How They Work With Codex

- **Delegates implementation, maintains quality control.** Expects autonomous execution but catches logical errors.
- **Expects momentum.** "keep going", "continue", "do all" — wants the work to flow without unnecessary pauses.
- **Wants results, not explanations.** Prefers to see the fix rather than read about what you plan to do.

## Communication Guidelines

- Match the user's energy and length. If they send 5 words, don't reply with 5 paragraphs.
- Lead with action, not preamble. Do the thing, then briefly note what you did.
- Don't add features that weren't asked for. Don't refactor surrounding code. Don't add comments or docstrings to code you didn't change.
- If something is broken, fix it and show proof. Don't explain what might be wrong — verify and demonstrate.

## 5 Example Messages (Generic Power User)

1. "the chart is broken on mobile. fix the responsive layout and check dark mode too"
2. "that's not what I asked for. revert the last change and just do X"
3. "great. now add filtering by date range"
4. "why is this still showing stale data. check the cache logic"
5. "stop explaining and just do it. show me the result"`;

let voiceProfileMeta = {
  status: "missing",
  provenance: "missing",
  messageCount: 0,
  generatedAt: null,
  loadedAt: null,
  runtimeAgent: RUNTIME_AGENT_LABEL,
  source: null,
  reason: "No voice profile on disk",
};

function parseMarkdownFrontmatter(raw) {
  const text = String(raw || "");
  const match = text.match(/^---\n([\s\S]*?)\n---\s*/);
  if (!match) return { attributes: {}, body: text.trim() };

  const attributes = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }

  return { attributes, body: text.slice(match[0].length).trim() };
}

function parseVoiceProfileMessageCount(attributes) {
  const direct = Number.parseInt(attributes.messageCount ?? attributes.message_count ?? "", 10);
  if (Number.isFinite(direct)) return direct;

  const description = String(attributes.description || "");
  const legacyMatch = description.match(/from (\d+) user messages/i);
  if (legacyMatch) return Number.parseInt(legacyMatch[1], 10);

  return null;
}

function sanitizeVoiceProfileMeta(meta) {
  return {
    status: meta.status || "missing",
    provenance: meta.provenance || meta.status || "missing",
    messageCount: Number.isFinite(meta.messageCount) ? meta.messageCount : null,
    generatedAt: meta.generatedAt || null,
    loadedAt: meta.loadedAt || null,
    runtimeAgent: meta.runtimeAgent || RUNTIME_AGENT_LABEL,
    source: meta.source || null,
    reason: meta.reason || "",
  };
}

function setVoiceProfileMeta(meta) {
  voiceProfileMeta = sanitizeVoiceProfileMeta(meta || {});
  return voiceProfileMeta;
}

function getVoiceProfileMeta() {
  return sanitizeVoiceProfileMeta(voiceProfileMeta);
}

function formatVoiceProfileMessageCount(count) {
  if (!Number.isFinite(count)) return "message count unknown";
  return `${count} user message${count === 1 ? "" : "s"}`;
}

function formatVoiceProfileTimestamp(timestamp) {
  if (!timestamp) return "timestamp unknown";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return String(timestamp);
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function buildPlaceholderVoiceProfile(messageCount, reason) {
  const label = messageCount === 0 ? "Generic fallback voice profile." : "Fallback voice profile.";
  return `> ${label} ${reason} This file stays on disk for transparency, but Autopilot Codex does not load it into the live runtime until it has enough current Codex user history.\n\n${DEFAULT_VOICE_PROFILE}`;
}

function inspectVoiceProfileFile() {
  if (!fs.existsSync(VOICE_PROFILE_FILE)) {
    return {
      exists: false,
      status: "missing",
      messageCount: 0,
      generatedAt: null,
      runtimeAgent: RUNTIME_AGENT_LABEL,
      source: null,
      reason: "No voice profile on disk",
      canLoad: false,
      body: "",
    };
  }

  try {
    const raw = fs.readFileSync(VOICE_PROFILE_FILE, "utf8");
    const { attributes, body } = parseMarkdownFrontmatter(raw);
    const messageCount = parseVoiceProfileMessageCount(attributes);
    const generatedAt = attributes.generated || attributes.generatedAt || null;
    const source = attributes.source || null;
    const runtimeAgent = normalizeProvenanceAgentLabel(
      attributes.runtimeAgent || attributes.agent,
      inferReferencedAgentLabelFromTexts(body) || RUNTIME_AGENT_LABEL
    );
    const explicitStatus = String(attributes.status || "").trim().toLowerCase().replace(/[_\s]/g, "-");
    const genericFallback = explicitStatus === "generic-fallback"
      || messageCount === 0;
    const fallback = explicitStatus === "placeholder"
      || explicitStatus === "fallback"
      || explicitStatus === "generic-fallback"
      || (Number.isFinite(messageCount) && messageCount > 0 && messageCount < VOICE_PROFILE_MIN_MESSAGES);
    const stale = /##\s+How They Work With Claude\b/i.test(body)
      || normalizeProvenanceAgentLabel(attributes.runtimeAgent || attributes.agent, "") === LEGACY_AGENT_LABEL;

    let status = "ready";
    let reason = "Trusted voice profile available";
    let canLoad = true;

    if (!body) {
      status = "invalid";
      reason = "Voice profile body is empty";
      canLoad = false;
    } else if (stale) {
      status = "stale";
      reason = "Profile still reflects Claude-era guidance";
      canLoad = false;
    } else if (genericFallback) {
      status = "generic_fallback";
      reason = "Generic fallback profile from 0 user messages";
      canLoad = false;
    } else if (fallback) {
      status = "fallback";
      reason = Number.isFinite(messageCount)
        ? `Fallback profile from ${formatVoiceProfileMessageCount(messageCount)}`
        : "Fallback profile with insufficient Codex history";
      canLoad = false;
    }

    return {
      exists: true,
      status,
      messageCount: Number.isFinite(messageCount) ? messageCount : null,
      generatedAt,
      runtimeAgent,
      source,
      reason,
      canLoad,
      body,
      attributes,
    };
  } catch (e) {
    return {
      exists: true,
      status: "invalid",
      messageCount: null,
      generatedAt: null,
      runtimeAgent: RUNTIME_AGENT_LABEL,
      source: null,
      reason: `Voice profile unreadable: ${e.message}`,
      canLoad: false,
      body: "",
    };
  }
}

function formatVoiceProfileStartupMessage(meta, suffix = "") {
  const count = formatVoiceProfileMessageCount(meta.messageCount);
  const generatedAt = formatVoiceProfileTimestamp(meta.generatedAt);

  if (meta.provenance === "loaded") {
    return `Voice profile loaded (${count}, generated ${generatedAt}).${suffix}`;
  }
  if (meta.provenance === "generated") {
    return `Voice profile generated and loaded (${count}, ${generatedAt}).${suffix}`;
  }
  if (meta.provenance === "generic_fallback") {
    return `Generic fallback voice profile detected (${count}, ${generatedAt}). Autopilot is running without a learned voice profile.${suffix}`;
  }
  if (meta.provenance === "fallback") {
    return `Fallback voice profile saved (${count}, ${generatedAt}). Autopilot is running without a trusted learned profile.${suffix}`;
  }
  return `Voice profile unavailable (${meta.reason || "unknown reason"}).${suffix}`;
}

function describeVoiceProfileRecovery(inspection) {
  if (inspection.status === "generic_fallback") {
    return `Generic fallback voice profile detected (${formatVoiceProfileMessageCount(inspection.messageCount)}, ${formatVoiceProfileTimestamp(inspection.generatedAt)}). Regenerating from current Codex history...`;
  }
  if (inspection.status === "fallback") {
    return `Fallback voice profile detected (${formatVoiceProfileMessageCount(inspection.messageCount)}, ${formatVoiceProfileTimestamp(inspection.generatedAt)}). Regenerating from current Codex history...`;
  }
  if (inspection.status === "stale") {
    return `Claude-era voice profile detected (${formatVoiceProfileMessageCount(inspection.messageCount)}, ${formatVoiceProfileTimestamp(inspection.generatedAt)}). Regenerating from current Codex history...`;
  }
  if (inspection.status === "invalid") {
    return `Voice profile unreadable (${inspection.reason}). Regenerating from current Codex history...`;
  }
  return "No trusted voice profile found — generating from your current Codex message history...";
}

// Step 1: Pull ~1000 user messages from Codex session logs
function collectUserMessages(targetCount = 1000) {
  const messages = [];
  if (!fs.existsSync(SESSIONS_DIR) && !fs.existsSync(ARCHIVED_SESSIONS_DIR)) return messages;
  try {
    for (const file of listSessionFiles()) {
      if (messages.length >= targetCount) break;
      try {
        const sessionInfo = scanSessionLogFile(file);
        if (classifySessionForDigest(sessionInfo)) continue;
        for (const msg of sessionInfo.userMessages) {
          if (messages.length >= targetCount) break;
          pushUserMessage(messages, msg);
        }
      } catch {}
    }
  } catch (e) {
    console.error("collectUserMessages error:", e.message);
  }
  return [...new Set(messages)].slice(0, targetCount);
}

async function runCodexTextQuery(prompt, systemPrompt, cwd = APP_DIR) {
  return new Promise((resolve, reject) => {
    const args = ["exec", "--json", "--skip-git-repo-check", "-m", BRAIN_MODEL, "-"];
    if (cwd) args.splice(3, 0, "-C", cwd);

    const child = spawn(CODEX_PATH, args, {
      cwd: APP_DIR,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finalText = "";

    function handleLine(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        finalText = finalText ? `${finalText}\n\n${event.item.text}` : event.item.text;
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (code !== 0) {
        reject(new Error(stderrBuffer.trim() || `Codex exited with code ${code}`));
        return;
      }
      if (!finalText.trim()) {
        reject(new Error("Voice analysis returned empty result"));
        return;
      }
      resolve(finalText.trim());
    });

    child.stdin.end(`${systemPrompt}\n\n${prompt}`);
  });
}

// Step 2: Analyze messages with Codex
async function analyzeVoicePatterns(messages) {
  const sample = [];
  const step = Math.max(1, Math.floor(messages.length / 40));
  for (let i = 0; i < messages.length && sample.length < 40; i += step) {
    sample.push(messages[i]);
  }
  const shuffled = [...messages].sort(() => Math.random() - 0.5);
  for (const m of shuffled) {
    if (sample.length >= 60) break;
    if (!sample.includes(m)) sample.push(m);
  }
  const messagesText = sample.map((m, i) => `${i + 1}. "${m}"`).join("\n");
  const prompt = `You are analyzing a user's messages to build a voice profile. Here are ${sample.length} messages from their Codex sessions (out of ${messages.length} total collected):

${messagesText}

Write a concise but specific markdown voice profile with these sections only:

## Voice & Style
- Message length, punctuation, capitalization, shorthand

## Thinking & Problem-Solving
- How they iterate, verify, and challenge claims

## Frustration & Satisfaction Signals
- How approval and frustration show up, with a few short examples

## How They Work With Codex
- What they expect from the runtime in terms of autonomy, speed, and explanation depth

## Communication Guidelines
- 4-6 practical rules for matching the user's style

## 6 Sample Messages In Their Voice
- Pick 6 representative messages from the set

Be concrete and pattern-based. Output only the markdown profile.`;
  return runCodexTextQuery(
    prompt,
    "You are a communication analyst. Analyze the messages and produce a detailed voice profile. Output ONLY the profile markdown with no preamble or explanation.",
    APP_DIR
  );
}

// Step 3: Write voice profile document
function writeVoiceProfile(analysis, options = {}) {
  const messageCount = Number.isFinite(options.messageCount) ? options.messageCount : 0;
  const defaultStatus = messageCount >= VOICE_PROFILE_MIN_MESSAGES
    ? "ready"
    : (messageCount === 0 ? "generic-fallback" : "fallback");
  const status = options.status || defaultStatus;
  const normalizedStatus = String(status).replace(/_/g, "-");
  const generatedAt = options.generatedAt || new Date().toISOString();
  const source = options.source || (normalizedStatus === "ready" ? "generated-from-codex-user-history" : "fallback-default");
  const description = status === "ready"
    ? `Auto-generated voice profile from ${messageCount} user messages — used to match communication style`
    : `${messageCount === 0 ? "Generic fallback" : "Fallback"} voice profile from ${messageCount} user messages — not trusted for runtime loading`;
  const content = `---
name: voice-profile
description: ${description}
type: ${normalizedStatus === "ready" ? "auto-generated" : "fallback"}
status: ${normalizedStatus}
messageCount: ${messageCount}
runtimeAgent: ${RUNTIME_AGENT_LABEL}
source: ${source}
generated: ${generatedAt}
---

${analysis}
`;
  atomicWriteSync(VOICE_PROFILE_FILE, content);
  const inspection = inspectVoiceProfileFile();
  setVoiceProfileMeta({
    ...inspection,
    provenance: normalizedStatus === "ready" ? "generated" : inspection.status,
    loadedAt: null,
  });
  console.log(`Voice profile written (${normalizedStatus}, ${messageCount} messages)`);
  return inspection;
}

// Load voice profile into system prompt if it exists
function loadVoiceProfile(options = {}) {
  const inspection = inspectVoiceProfileFile();
  if (!inspection.canLoad) {
    syncSystemPromptFile();
    setVoiceProfileMeta({
      ...inspection,
      provenance: inspection.status === "missing" ? "missing" : inspection.status,
      loadedAt: null,
    });
    return null;
  }

  syncSystemPromptFile(inspection.body);
  const meta = setVoiceProfileMeta({
    ...inspection,
    provenance: options.provenance || "loaded",
    loadedAt: new Date().toISOString(),
  });
  console.log(`Voice profile loaded into chat system prompt (${formatVoiceProfileMessageCount(meta.messageCount)}, generated ${formatVoiceProfileTimestamp(meta.generatedAt)})`);
  return meta;
}

// Full pipeline: collect → analyze → write → load
async function generateVoiceProfile() {
  let collectedCount = 0;
  try {
    addChat("system", "Generating voice profile — Step 1: collecting user messages...");
    broadcastState();
    const messages = collectUserMessages(1000);
    collectedCount = messages.length;
    if (messages.length < VOICE_PROFILE_MIN_MESSAGES) {
      addChat("system", `Only found ${messages.length} current Codex user messages — writing a placeholder profile. It will not be loaded until there is enough history.`);
      broadcastState();
      const inspection = writeVoiceProfile(
        buildPlaceholderVoiceProfile(messages.length, `Only ${formatVoiceProfileMessageCount(messages.length)} were available.`),
        {
          messageCount: messages.length,
          status: messages.length === 0 ? "generic-fallback" : "fallback",
          source: "fallback-default",
        }
      );
      syncSystemPromptFile();
      return getVoiceProfileMeta() || inspection;
    }
    addChat("system", `Step 1 complete: collected ${messages.length} unique messages`);
    broadcastState();

    addChat("system", `Step 2: analyzing voice patterns with ${APP_NAME}...`);
    broadcastState();
    const analysis = await analyzeVoicePatterns(messages);
    addChat("system", "Step 2 complete: voice analysis done");
    broadcastState();

    addChat("system", "Step 3: writing voice profile...");
    broadcastState();
    writeVoiceProfile(analysis, {
      messageCount: messages.length,
      status: "ready",
      source: "generated-from-codex-user-history",
    });
    const loaded = loadVoiceProfile({ provenance: "generated" });
    addChat("system", `Voice profile generated from ${messages.length} messages and loaded`);
    broadcastState();
    return loaded || getVoiceProfileMeta();
  } catch (e) {
    console.error("Voice profile generation failed:", e.message);
    addChat("system", `Voice analysis unavailable (${e.message.split("—")[0].trim()}). Writing a placeholder profile and continuing without loading it.`);
    broadcastState();
    writeVoiceProfile(
      buildPlaceholderVoiceProfile(collectedCount, "Voice analysis did not complete."),
      {
        messageCount: collectedCount,
        status: collectedCount === 0 ? "generic-fallback" : "fallback",
        source: "analysis-unavailable",
      }
    );
    syncSystemPromptFile();
    return getVoiceProfileMeta();
  }
}

// Build a compact thread summary for the brain
function buildThreadSummary() {
  const digest = loadKnowledge().threadDigest;
  const allSessions = Object.entries(digest.sessions)
    .filter(([, data]) => data.messageCount > 0)
    .sort((a, b) => (b[1].lastTimestamp || 0) - (a[1].lastTimestamp || 0));

  if (allSessions.length === 0) return "";

  // Split into active-project sessions and others
  const isActiveProject = (data) => {
    const project = data.inferredProject || (data.cwd ? path.basename(data.cwd) : null);
    if (!project) return false;
    if (activeProjects.length > 0) return activeProjects.some(p => project.includes(p));
    return false;
  };

  const activeSessions = allSessions.filter(([, data]) => isActiveProject(data)).slice(0, 3);
  const otherSessions = allSessions.filter(([, data]) => !isActiveProject(data)).slice(0, 2);

  let summary = `## Imported Thread History\nThese session notes are historical context, not the live runtime. Active runtime is ${RUNTIME_AGENT_LABEL}.\n`;

  // Active project sessions get compact detail
  if (activeSessions.length > 0) {
    summary += `\n## Active Project Thread History (${activeProjects.join(", ")})\n`;
    for (const [id, data] of activeSessions) {
      const date = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleDateString() : "?";
      const project = data.inferredProject || path.basename(data.cwd || "");
      const sourceAgent = normalizeProvenanceAgentLabel(data.sourceAgent, RUNTIME_AGENT_LABEL);
      const referencedAgent = normalizeProvenanceAgentLabel(
        data.referencedAgent,
        inferReferencedAgentLabelFromTexts(data.lastAssistantText, (data.userMessages || []).join("\n")) || UNKNOWN_AGENT_LABEL
      );
      const msgs = [...new Set((data.userMessages || []).filter(m =>
        !m.startsWith("continue") && !m.startsWith("<") && m.length > 5
      ))].slice(0, 3);
      if (msgs.length === 0) continue;

      summary += `\n### ${project} (${date}, ${data.messageCount} msgs)\n`;
      summary += `Imported from ${sourceAgent}; referenced runtime ${referencedAgent}; session ${id.slice(0, 8)}.\n`;
      if (data.lastAssistantText) {
        summary += `Last imported note: "${data.lastAssistantText.slice(0, 180)}"\n`;
      }
      summary += `Recent imported user asks:\n`;
      for (const m of msgs) {
        summary += `- "${m.slice(0, 110)}"\n`;
      }
    }
  }

  // Other sessions get compressed one-liners
  if (otherSessions.length > 0) {
    summary += `\n## Other Imported Thread History\n`;
    for (const [id, data] of otherSessions) {
      const date = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleDateString() : "?";
      const project = data.inferredProject || path.basename(data.cwd || "unknown");
      const sourceAgent = normalizeProvenanceAgentLabel(data.sourceAgent, RUNTIME_AGENT_LABEL);
      const referencedAgent = normalizeProvenanceAgentLabel(
        data.referencedAgent,
        inferReferencedAgentLabelFromTexts(data.lastAssistantText, (data.userMessages || []).join("\n")) || UNKNOWN_AGENT_LABEL
      );
      const topMsg = (data.userMessages || []).find(m => m.length > 5 && !m.startsWith("continue") && !m.startsWith("<"));
      summary += `- ${project} (${date}, ${data.messageCount} msgs) — imported ${sourceAgent}, referenced ${referencedAgent}${topMsg ? `: "${topMsg.slice(0, 70)}"` : ""}\n`;
    }
  }

  return summary;
}

function buildPendingReceiptSection() {
  const pending = findings
    .filter((f) => !isSyntheticBenchmarkFinding(f))
    .filter(f => activeProjects.length === 0 || activeProjects.some(p => f.project && f.project.includes(p)))
    .filter(f => f.status === "sent" && f.sentPrompt)
    .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
    .slice(0, 5);

  if (!pending.length) return "";

  const lines = pending.map((f) => {
    const target = f.sendTarget || "unknown-target";
    const sentAt = f.sentAt ? new Date(f.sentAt).toLocaleTimeString() : "unknown time";
    const attempt = f.sendAttemptId ? ` attempt:${shortSendAttemptId(f.sendAttemptId)}` : "";
    return `- ${f.id}${attempt} [via ${target} at ${sentAt}] "${String(f.sentPrompt || "").slice(0, 160)}"`;
  }).join("\n");

  return `## Sent Findings Awaiting Exact Receipt Proof
Do NOT mark these received just because the conversation is active. Only confirm one if the live screenshot or CLI state clearly matches the exact prompt below. Echo lastSendFindingId and lastSendAttemptId when you verify one.
${lines}`;
}

function buildOpenInsightSection() {
  const statusPriority = { received: 0, sent: 1, queued: 2, identified: 3 };
  const scoped = findings
    .filter((f) => ["identified", "queued", "sent", "received"].includes(f.status))
    .filter((f) => !isSyntheticBenchmarkFinding(f))
    .filter((f) => activeProjects.length === 0 || activeProjects.some((p) => f.project && f.project.includes(p)))
    .sort((a, b) => {
      const ap = statusPriority[a.status] ?? 9;
      const bp = statusPriority[b.status] ?? 9;
      if (ap !== bp) return ap - bp;
      const aHasPrompt = a.pendingPrompt || (a.messages && a.messages.some(isPendingFindingMessage)) ? 0 : 1;
      const bHasPrompt = b.pendingPrompt || (b.messages && b.messages.some(isPendingFindingMessage)) ? 0 : 1;
      if (aHasPrompt !== bHasPrompt) return aHasPrompt - bHasPrompt;
      return String(b.lastSeen || b.firstSeen || "").localeCompare(String(a.lastSeen || a.firstSeen || ""));
    });

  if (!scoped.length) return "";

  const counts = ["received", "sent", "queued", "identified"]
    .map((status) => {
      const count = scoped.filter((f) => f.status === status).length;
      return count ? `${count} ${status}` : null;
    })
    .filter(Boolean)
    .join(", ");

  const lines = scoped.slice(0, 12).map((f) => {
    let line = `  [${f.status}] ${f.title} (${f.id})`;
    if (f.goalId) line += ` → goal:${f.goalId}`;
    if (f.status === "received") line += " — awaiting close-out";
    else if (f.status === "sent") line += ` — awaiting exact receipt${f.sendAttemptId ? ` (attempt:${shortSendAttemptId(f.sendAttemptId)})` : ""}`;
    else if (f.status === "queued") line += " — queued for delivery";
    else if (f.pendingPrompt || (f.messages && f.messages.some(isPendingFindingMessage))) line += " — ready to send";
    return line;
  }).join("\n");

  let section = `## Open Insights Requiring Attention\nCurrent scope: ${scoped.length} open insights${counts ? ` (${counts})` : ""}.\n${lines}`;
  if (scoped.length > 12) {
    section += `\n... and ${scoped.length - 12} more open insights remain in server state.`;
  }
  section += `\n\nLifecycle focus:\n- Brain creates identified insights with goalId.\n- Server moves prompts through queued/sent and only marks received with exact proof.\n- Brain must close received insights to implemented or failed when evidence appears.`;
  return section;
}

// Thread scan loop — runs every 5 minutes
let threadScanTimer = null;
function startThreadScanLoop() {
  // Initial scan
  scanRecentThreads();
  threadScanTimer = setInterval(() => {
    const digest = scanRecentThreads();
    broadcast({ type: "knowledgeUpdate", lastScan: digest.lastScan, stats: digest.stats });
    broadcastState();
  }, 5 * 60 * 1000);
}
startThreadScanLoop();

// Extract goals from threads and link existing findings on startup
setTimeout(() => {
  extractGoalsFromThreads();
  linkExistingFindings();
  console.log(`[goals] Loaded ${Object.keys(goalsData.projects).length} projects, ${Object.values(goalsData.projects).reduce((s, p) => s + (p.goals?.length || 0), 0)} goals`);
}, 2000);

// Re-extract goals from threads whenever thread scanner runs
const origScanRecentThreads = scanRecentThreads;
scanRecentThreads = function() {
  const result = origScanRecentThreads();
  extractGoalsFromThreads();
  return result;
};

// State
let running = false;
let state = "IDLE";
let cycleCount = 0;
const MUTE_FILE = path.join(AUTOPILOT_DIR, "mute-state.json");
let muteMode = (() => {
  try {
    const val = JSON.parse(fs.readFileSync(MUTE_FILE, "utf8")).muted;
    console.log(`[startup] Loaded mute state from disk: ${val}`);
    return val;
  } catch (e) {
    console.error(`[startup] Failed to read mute state, defaulting to muted:`, e.message);
    return true;
  }
})();
let dashboardTab = "chat"; // which tab the user is viewing: chat, tracker, cli
let lastChatTime = 0; // timestamp of last chatWithBrain completion — suppresses auto-cycle echo
// muteQueue removed — deferred sends now use pendingPrompt on findings
let lastSentMessage = "";
let lastSentFindingId = null;
let lastSentAttemptId = null;
let lastSentTarget = null;
let lastSendFailed = false;
let sendsPending = 0;  // how many sends haven't been acknowledged yet
let sendsDelivered = 0;
let sendsIgnored = 0;
let loopTimer = null;
const GUIDANCE_FILE = path.join(AUTOPILOT_DIR, "guidance.txt");
let userGuidance = "";
try { userGuidance = fs.readFileSync(GUIDANCE_FILE, "utf8").trim(); } catch {}
// goals.json mission is source of truth — override guidance.txt
if (goalsData.mission) userGuidance = goalsData.mission;
const ACTIVE_PROJECTS_FILE = path.join(AUTOPILOT_DIR, "active-projects.json");
const HAS_SAVED_ACTIVE_PROJECTS = fs.existsSync(ACTIVE_PROJECTS_FILE);
let activeProjects = [];
try { activeProjects = JSON.parse(fs.readFileSync(ACTIVE_PROJECTS_FILE, "utf8")); } catch {}
function isGitRepoDir(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function findNearestGitRepo(startDir) {
  if (!startDir) return null;
  let current = path.resolve(startDir);
  while (true) {
    if (isGitRepoDir(current)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) return null;
    current = parent;
  }
}

function uniqProjectNames(names) {
  return [...new Set((names || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// Discover all git projects in the user's working directory
function discoverProjects() {
  const projects = [];
  const currentRepo = findNearestGitRepo(USER_CWD);
  if (currentRepo) projects.push(path.basename(currentRepo));
  try {
    for (const d of fs.readdirSync(USER_CWD)) {
      try {
        if (isGitRepoDir(path.join(USER_CWD, d))) projects.push(d);
      } catch {}
    }
  } catch {}
  return uniqProjectNames(projects);
}
const allProjects = discoverProjects();

function getCurrentRepoCandidate() {
  const candidates = [];

  const projectCtx = gatherProjectContext();
  if (projectCtx?.cwd) {
    candidates.push({
      dir: projectCtx.cwd,
      source: projectCtx.cwdResolved ? "auto-detected project context" : "active project context",
    });
  }
  candidates.push({ dir: USER_CWD, source: "server working directory" });

  try {
    const digest = loadKnowledge().threadDigest;
    const sessions = Object.values(digest.sessions || {})
      .sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
    for (const session of sessions) {
      if (session.cwd) {
        candidates.push({ dir: session.cwd, source: "latest imported session" });
        break;
      }
    }
  } catch {}

  for (const candidate of candidates) {
    const repoPath = findNearestGitRepo(candidate.dir);
    if (!repoPath) continue;
    return {
      name: path.basename(repoPath),
      path: repoPath,
      source: candidate.source,
    };
  }

  return null;
}

function resolveProjectWorkingDir(projectName) {
  if (!projectName) return null;

  const currentRepo = findNearestGitRepo(USER_CWD);
  if (currentRepo && path.basename(currentRepo) === projectName) return currentRepo;

  const directChild = path.join(USER_CWD, projectName);
  const directRepo = findNearestGitRepo(directChild);
  if (directRepo && path.basename(directRepo) === projectName) return directRepo;

  try {
    const entries = fs.readdirSync(USER_CWD, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== projectName) continue;
      const repo = findNearestGitRepo(path.join(USER_CWD, entry.name));
      if (repo) return repo;
    }
  } catch {}

  return null;
}

function getBrainWorkingDir(sessionType = "cycle") {
  if (sessionType !== "cycle") return USER_CWD;
  if (activeProjects.length !== 1) return USER_CWD;
  return resolveProjectWorkingDir(activeProjects[0]) || USER_CWD;
}

function listSelectableProjects(currentRepoCandidate = null) {
  return uniqProjectNames([
    ...allProjects,
    ...activeProjects,
    currentRepoCandidate?.name,
  ]);
}

function autoSelectInitialProjectIfNeeded() {
  if (HAS_SAVED_ACTIVE_PROJECTS || activeProjects.length > 0) return null;

  const currentRepoCandidate = getCurrentRepoCandidate();
  if (!currentRepoCandidate?.name) return null;

  activeProjects = [currentRepoCandidate.name];
  if (!allProjects.includes(currentRepoCandidate.name)) {
    allProjects.push(currentRepoCandidate.name);
    allProjects.sort((a, b) => a.localeCompare(b));
  }
  try { atomicWriteSync(ACTIVE_PROJECTS_FILE, JSON.stringify(activeProjects)); } catch {}

  if (!goalsData.projects[currentRepoCandidate.name]) {
    goalsData.projects[currentRepoCandidate.name] = { description: "", goals: [] };
    saveGoals();
  }

  return currentRepoCandidate;
}
const startTime = Date.now();

// Cycle history — last 20 brain cycles (5 shown in detail, 20 in sparkline)
let cycleHistory = [];

// Sent message history for dedup (persisted to disk)
const SENT_HISTORY_FILE = path.join(AUTOPILOT_DIR, "sent-history.json");
let sentHistory = [];
try { sentHistory = JSON.parse(fs.readFileSync(SENT_HISTORY_FILE, "utf8")); } catch {}

// Suggested prompt history for dedup (separate from sends)
let suggestedHistory = [];

function wordSet(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
}

function similarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) { if (setB.has(w)) overlap++; }
  return overlap / Math.max(setA.size, setB.size);
}

function isDuplicate(prompt) {
  for (const prev of sentHistory.slice(0, 5)) {
    if (similarity(prompt, prev) > 0.6) return true;
  }
  return false;
}

function isSuggestionDuplicate(prompt) {
  for (const prev of suggestedHistory.slice(0, 10)) {
    if (similarity(prompt, prev) > 0.6) return true;
  }
  return false;
}

// Brain session tracking — separate sessions for chat vs auto-cycles
// Chat session: truly persistent — survives restarts, loaded from disk
// Cycle session: ephemeral, rotates independently, and should never survive restart
const SESSION_FILE = path.join(AUTOPILOT_DIR, "brain-sessions.json");
let chatSessionId = null;
let chatContextTokens = 0;
let cycleSessionId = null;
let cycleContextTokens = 0;
// Load persisted sessions
try {
  const sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  chatSessionId = sessions.chatSessionId || null;
  if (sessions.cycleSessionId) {
    console.log("[startup] Cleared stale auto-cycle Codex session from disk");
    cycleSessionId = null;
  }
} catch {}
function saveSessions() {
  try { atomicWriteSync(SESSION_FILE, JSON.stringify({ chatSessionId }, null, 2)); } catch {}
}
// Legacy alias used by callBrain — will be set per-call
let brainSessionId = null;
let brainContextTokens = 0;
let lastSentThreadSummary = null; // Delta tracking — avoid resending unchanged context
let lastSentProjectCtx = null;
const CONTEXT_ROTATION_THRESHOLD = 190000; // Rotate at 190K — maximize session memory

// Chat log for dashboard — persisted to disk for continuity
const CHAT_LOG_FILE = path.join(AUTOPILOT_DIR, "chat-log.json");
const CHAT_SUMMARY_FILE = path.join(AUTOPILOT_DIR, "chat-summary.md");
let chatLog = [];
let chatSummary = "";
try {
  const saved = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf8"));
  if (Array.isArray(saved)) chatLog = saved.slice(-200); // Keep last 200
} catch {}
try { chatSummary = fs.readFileSync(CHAT_SUMMARY_FILE, "utf8").trim(); } catch {}

function listImportedHistoryAgents() {
  const agents = new Set();
  try {
    const digest = loadKnowledge().threadDigest;
    for (const data of Object.values(digest.sessions || {})) {
      const referenced = normalizeProvenanceAgentLabel(
        data.referencedAgent,
        inferReferencedAgentLabelFromTexts(data.lastAssistantText, (data.userMessages || []).join("\n")) || ""
      );
      if (referenced && referenced !== UNKNOWN_AGENT_LABEL) agents.add(referenced);
    }
  } catch {}
  const summaryAgent = inferReferencedAgentLabelFromTexts(chatSummary);
  if (summaryAgent) agents.add(summaryAgent);
  const memoryAgent = inferReferencedAgentLabelFromTexts(getAutopilotMemoryMarkdown());
  if (memoryAgent) agents.add(memoryAgent);
  return [...agents];
}

function buildRuntimeIdentitySection() {
  const importedAgents = listImportedHistoryAgents();
  const importedLine = importedAgents.length
    ? ` Imported history currently mentions: ${importedAgents.join(", ")}.`
    : "";
  return `## Runtime Identity\n- Active runtime agent: ${RUNTIME_AGENT_LABEL}. This session's live brain output is ${RUNTIME_AGENT_LABEL}.\n- Imported history: rotated summaries, thread digests, and legacy notes are historical context only. They are not the active runtime unless current screenshot, git state, or fresh ${RUNTIME_AGENT_LABEL} output confirms them.${importedLine}`;
}

function summarizeImportedHistoryForUI() {
  const importedAgents = listImportedHistoryAgents();
  return importedAgents.length ? importedAgents.join(", ") : "none";
}

function formatChatSummaryForPrompt(summary) {
  const body = String(summary || "").trim();
  if (!body) return "";

  const lines = body.split("\n")
    .filter(Boolean)
    .map(line => {
      if (/^##\s/i.test(line)) return null;
      if (/^-\s*Brain:/i.test(line)) return line.replace(/^-\s*Brain:/i, "- Prior runtime note:");
      if (/^-\s*User:/i.test(line)) return line.replace(/^-\s*User:/i, "- Prior user message:");
      return line;
    })
    .filter(Boolean);

  const referencedAgent = inferReferencedAgentLabelFromTexts(body);
  const note = referencedAgent && referencedAgent !== UNKNOWN_AGENT_LABEL
    ? ` Some imported notes mention ${referencedAgent}.`
    : "";
  return `## Imported Chat Summary From Prior Sessions\nThis is carried-forward history, not the live runtime. Active runtime is ${RUNTIME_AGENT_LABEL}.${note}\n${lines.join("\n")}`;
}

function describeGoalProvenance(goal) {
  const source = String(goal?.source || "").trim().toLowerCase();
  if (source === "brain") return `active ${RUNTIME_AGENT_LABEL} runtime`;
  if (source === "thread") return "imported thread history";
  if (source === "user") return "dashboard user";
  if (!source) return "unspecified";
  return source;
}

function describeInsightProvenance(insight) {
  if (insight?.sourceAgent) {
    return `active ${normalizeProvenanceAgentLabel(insight.sourceAgent, RUNTIME_AGENT_LABEL)} runtime`;
  }
  return `active ${RUNTIME_AGENT_LABEL} runtime`;
}

function saveChatLog() {
  try { atomicWriteSync(CHAT_LOG_FILE, JSON.stringify(chatLog.slice(-200), null, 2)); } catch {}
}
// Build a conversation summary from recent chat for session continuity
function buildChatSummary() {
  const convos = chatLog.filter(m => m.role === "user" || m.role === "brain");
  if (convos.length === 0) return "";
  const lines = convos.slice(-30).map(m => {
    const who = m.role === "user" ? "User" : `${RUNTIME_AGENT_LABEL} runtime`;
    return `- ${who}: ${m.text.slice(0, 200)}`;
  });
  return `## Imported Chat Summary From Prior Sessions\nThis is carried-forward history, not the live runtime. Active runtime is ${RUNTIME_AGENT_LABEL}.\n${lines.join("\n")}`;
}

let settings = { interval: 180 };
const STATELESS_AUTO_CYCLES = process.env.AUTOPILOT_STATELESS_CYCLES !== "0";

// ─── CLI Pilot (v1 integration) ────────────────────────────────────────────
const CLI_SESSION = process.env.CLI_SESSION || "codex-auto";
let cliQueue = [];
let cliHistory = [];
let cliStatus = "disconnected"; // disconnected, idle, working
let cliAutoMode = true;
let cliLastScreen = "";
let cliAutoSendPending = false;
const CLI_STATE_FILE = path.join(AUTOPILOT_DIR, "cli-queue.json");
try {
  const saved = JSON.parse(fs.readFileSync(CLI_STATE_FILE, "utf8"));
  if (saved.queue) cliQueue = saved.queue;
  if (saved.history) cliHistory = saved.history;
} catch {}
function cliSaveState() {
  try { atomicWriteSync(CLI_STATE_FILE, JSON.stringify({ queue: cliQueue, history: cliHistory }, null, 2)); } catch {}
}

function normalizeCliQueue() {
  reloadFindingsFromDisk();
  let changed = false;
  const seenFindingIds = new Set();
  const nextQueue = [];

  for (const item of cliQueue) {
    if (!item?.text) {
      changed = true;
      continue;
    }

    if (!item.findingId) {
      nextQueue.push(item);
      continue;
    }

    const finding = findings.find(f => f.id === item.findingId);
    if (!finding) {
      changed = true;
      continue;
    }

    if (!["identified", "queued"].includes(finding.status)) {
      changed = true;
      continue;
    }

    if (seenFindingIds.has(item.findingId)) {
      changed = true;
      continue;
    }

    seenFindingIds.add(item.findingId);
    nextQueue.push(item);
  }

  if (changed) {
    cliQueue = nextQueue;
    cliSaveState();
  }
}

normalizeCliQueue();

function migrateLegacyDesktopSendsToCliQueue() {
  if (!shouldPreferCliDelivery()) return;
  reloadFindingsFromDisk();
  let migrated = 0;

  for (const finding of findings) {
    if (!finding || finding.status !== "sent") continue;
    if (finding.sendTarget !== "desktop") continue;
    if (finding.receiptSource) continue;
    if (isSyntheticBenchmarkFinding(finding)) continue;

    const prompt = finding.sentPrompt
      || finding.pendingPrompt
      || findFindingMessage(finding, finding.sentPrompt, finding.sendAttemptId)?.text
      || (Array.isArray(finding.messages) ? finding.messages.find((message) => message?.text)?.text : null);
    if (!prompt) continue;

    const attemptId = createSendAttemptId(finding.id);
    queueCliDelivery(`autopilot: ${prompt}`, {
      id: finding.id,
      title: finding.title,
      prompt,
      attemptId,
    }, {
      originalText: prompt,
      prompt,
    });
    applySendResultToFindingRecord(finding, prompt, {
      ok: true,
      target: "cli",
      receipt: "queued",
      attemptId,
    });
    finding.lastIgnoredSource = "startup-migrated-to-cli";
    finding.lastIgnoredEvidence = "Legacy desktop send had no exact receipt proof and was migrated to dedicated Codex CLI delivery on startup.";
    finding.lastIgnoredAt = new Date().toISOString();
    migrated++;
  }

  if (migrated > 0) {
    saveFindings();
    cliSaveState();
    console.log(`[startup] Migrated ${migrated} legacy desktop sends to dedicated CLI queue`);
  }
}

migrateLegacyDesktopSendsToCliQueue();

function cliCapturePane() {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", CLI_SESSION, "-p"], { encoding: "utf8", timeout: 5000 });
  } catch { return null; }
}

function cliSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cliCurrentPromptText(screen) {
  if (!screen) return "";
  const lines = screen.split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^(❯|›)\s/.test(line)) return line.replace(/^(❯|›)\s*/, "");
  }
  return "";
}

function cliPromptContainsMessage(screen, message) {
  if (!screen || !message) return false;
  return cliCurrentPromptText(screen).includes(message.trim());
}

function cliScreenState(screen) {
  if (!screen) return "disconnected";
  const normalized = screen.toLowerCase();
  if (normalized.includes("do you trust the contents of this directory") || normalized.includes("press enter to continue")) {
    return "trust";
  }
  if (normalized.includes("esc to interrupt")) return "working";

  const lines = screen.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.some(l => /^(❯|›)\s/.test(l))) return "idle";
  return "working";
}

function cliIsIdle(screen) {
  return cliScreenState(screen) === "idle";
}

function cliCanDeliver() {
  const screen = cliCapturePane();
  const state = cliScreenState(screen);
  if (screen && screen !== cliLastScreen) {
    cliLastScreen = screen;
    broadcast({ type: "cli_terminal", content: screen });
  }
  if (state === "idle") cliStatus = "idle";
  else if (state === "working" || state === "trust") cliStatus = "working";
  else cliStatus = "disconnected";
  return state === "idle" || state === "working";
}

function cliCreateSession() {
  try {
    execFileSync("tmux", [
      "new-session",
      "-d",
      "-s",
      CLI_SESSION,
      "-c",
      USER_CWD,
      `${CODEX_PATH} -C ${USER_CWD}`,
    ], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureCliSessionReady(options = {}) {
  const requireIdle = options.requireIdle !== false;
  const autoStart = options.autoStart !== false;
  const deadline = Date.now() + (options.timeoutMs || 20000);
  let attemptedCreate = false;

  while (Date.now() < deadline) {
    const screen = cliCapturePane();
    const state = cliScreenState(screen);

    if (screen && screen !== cliLastScreen) {
      cliLastScreen = screen;
      broadcast({ type: "cli_terminal", content: screen });
    }

    if (state === "trust") {
      if (cliSendToTmux("")) {
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
    }

    if (state === "idle") {
      cliStatus = "idle";
      broadcastState();
      return true;
    }

    if (!requireIdle && state === "working") {
      cliStatus = "working";
      broadcastState();
      return true;
    }

    if (state === "disconnected" && autoStart && !attemptedCreate) {
      attemptedCreate = true;
      if (cliCreateSession()) {
        cliStatus = "working";
        broadcastState();
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
    }

    cliStatus = state === "disconnected" ? "disconnected" : "working";
    await new Promise(r => setTimeout(r, 1000));
  }

  broadcastState();
  return false;
}

function cliSendToTmux(msg) {
  try {
    if (msg) {
      execFileSync("tmux", ["send-keys", "-t", CLI_SESSION, "-l", msg], { timeout: 5000 });
      cliSleep(300);
    }
    execFileSync("tmux", ["send-keys", "-t", CLI_SESSION, "C-m"], { timeout: 5000 });
    return true;
  } catch { return false; }
}

function pruneCliQueueForFinding(findingId, keepAttemptId = null) {
  if (!findingId) return 0;
  const before = cliQueue.length;
  cliQueue = cliQueue.filter((item) => {
    if (item.findingId !== findingId) return true;
    if (keepAttemptId && item.attemptId === keepAttemptId) return true;
    return false;
  });
  if (cliQueue.length !== before) cliSaveState();
  return before - cliQueue.length;
}

function queueCliDelivery(message, findingCtx, options = {}) {
  if (findingCtx?.id) pruneCliQueueForFinding(findingCtx.id);
  const existing = cliQueue.find((item) =>
    item?.text === message
    && (findingCtx?.id ? item.findingId === findingCtx.id : true)
  );
  const queueItem = existing || {
    id: Date.now(),
    text: message,
    originalText: options.originalText || message,
    status: "queued",
    queuedAt: new Date().toISOString(),
    findingId: findingCtx?.id || null,
    attemptId: findingCtx?.attemptId || null,
    prompt: findingCtx?.prompt || options.prompt || options.originalText || message,
    title: findingCtx?.title || null,
  };

  if (!existing) cliQueue.push(queueItem);
  cliSaveState();

  return {
    ok: true,
    target: "cli",
    receipt: "queued",
    queued: true,
    attemptId: queueItem.attemptId || null,
  };
}

function shouldAutoDispatchCliQueueItem(item) {
  if (!item) return false;
  // Finding-backed items come from the dedicated autopilot delivery path and
  // should resume automatically once the tmux session is idle.
  return !!item.findingId || cliAutoMode;
}

function hasAutoDispatchableCliQueueItem() {
  return cliQueue.some(shouldAutoDispatchCliQueueItem);
}

function takeNextAutoDispatchableCliQueueItem() {
  if (!cliQueue.length) return null;
  if (cliAutoMode) return cliQueue.shift() || null;
  const idx = cliQueue.findIndex(item => item?.findingId);
  if (idx === -1) return null;
  return cliQueue.splice(idx, 1)[0] || null;
}

function cliDispatchQueuedItem(item, type = "auto") {
  if (!item) return false;
  if (!cliSendToTmux(item.text)) return false;

  cliHistory.push({ text: item.text, time: new Date().toLocaleTimeString(), type });
  if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
  cliStatus = "working";
  cliSaveState();

  if (item.findingId) {
    reloadFindingsFromDisk();
    const finding = findings.find(f => f.id === item.findingId);
    if (finding) {
      applySendResultToFindingRecord(
        finding,
        item.prompt || item.originalText || item.text,
        { ok: true, target: "cli", receipt: "sent", attemptId: item.attemptId || null }
      );
      saveFindings();
      broadcastFindingUpdate(finding.id, finding.status, buildFindingStatusBroadcastExtra(finding, finding.sentPrompt || item.prompt || null));
    }
  }

  recordSuccessfulSend(item.originalText || item.text, item.findingId ? {
    id: item.findingId,
    attemptId: item.attemptId || null,
  } : null, { target: "cli", receiptConfirmed: false });

  cliVerifySend(item);
  broadcastState();
  return true;
}

function cliHandleAction(msg) {
  switch (msg.action) {
    case "cli_add":
      cliQueue.push({ id: Date.now(), text: msg.text, status: "queued" });
      break;
    case "cli_remove":
      cliQueue = cliQueue.filter(q => q.id !== msg.id);
      break;
    case "cli_reorder": {
      const item = cliQueue.splice(msg.from, 1)[0];
      if (item) cliQueue.splice(msg.to, 0, item);
      break;
    }
    case "cli_edit": {
      const q = cliQueue.find(q => q.id === msg.id);
      if (q) q.text = msg.text;
      break;
    }
    case "cli_send_now":
      if (cliSendToTmux(msg.text)) {
        cliHistory.push({ text: msg.text, time: new Date().toLocaleTimeString(), type: "manual" });
        if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
        cliStatus = "working";
      }
      break;
    case "cli_send_queued": {
      const idx = cliQueue.findIndex(q => q.id === msg.id);
      if (idx === -1) break;
      const item2 = cliQueue.splice(idx, 1)[0];
      if (!cliDispatchQueuedItem(item2, "manual")) cliQueue.unshift(item2);
      break;
    }
    case "cli_toggle_auto":
      cliAutoMode = !cliAutoMode;
      break;
  }
  cliSaveState();
  broadcastState();
}

// Post-send verification: if Claude never starts working, re-queue the item
function cliVerifySend(item) {
  let checks = 0;
  const iv = setInterval(() => {
    checks++;
    const screen = cliCapturePane();
    const state = cliScreenState(screen);
    const promptStillStaged = cliPromptContainsMessage(screen, item.text);
    if (state === "working" || state === "disconnected" || (state === "idle" && !promptStillStaged)) {
      clearInterval(iv);
      if (item.findingId) {
        const source = state === "working" ? "cli-working" : "cli-accepted";
        const evidence = state === "working"
          ? "Dedicated Codex CLI accepted the prompt from queue and entered a working state."
          : "Dedicated Codex CLI accepted the queued prompt and cleared it from the input line.";
        const applied = markFindingReceived(item.findingId, {
          attemptId: item.attemptId || null,
          prompt: item.prompt || item.originalText || item.text,
          source,
          evidence,
          target: "cli",
        });
        if (applied) noteSendVerification("delivered");
      }
      return;
    }
    if (checks >= 16) { // 8 seconds (16 * 500ms) still idle — re-queue
      clearInterval(iv);
      cliQueue.unshift(item);
      // Remove from history since it didn't actually work
      const idx = cliHistory.findLastIndex(h => h.text === item.text);
      if (idx !== -1) cliHistory.splice(idx, 1);
      cliStatus = "idle";
      if (item.findingId) {
        noteSendVerification("ignored");
        markFindingQueued(item.findingId, {
          attemptId: item.attemptId || null,
          prompt: item.prompt || item.originalText || item.text,
          source: "cli-idle-timeout",
          evidence: "Dedicated Codex CLI stayed idle after the queued send attempt, so the prompt was re-queued.",
        });
      }
      cliSaveState();
      broadcastState();
    }
  }, 500);
}

// CLI polling loop — check tmux every 2s
setInterval(() => {
  const screen = cliCapturePane();
  const state = cliScreenState(screen);
  if (state === "disconnected") {
    if (cliStatus !== "disconnected") {
      cliStatus = "disconnected";
      broadcastState();
    }
    return;
  }
  // Broadcast terminal content if changed
  if (screen !== cliLastScreen) {
    cliLastScreen = screen;
    broadcast({ type: "cli_terminal", content: screen });
  }
  const idle = state === "idle";
  if (idle && cliStatus !== "idle") {
    cliStatus = "idle";
    broadcastState();
    if (hasAutoDispatchableCliQueueItem()) {
      cliAutoSendPending = true;
      setTimeout(() => {
        cliAutoSendPending = false;
        if (cliStatus === "idle" && hasAutoDispatchableCliQueueItem()) {
          const next = takeNextAutoDispatchableCliQueueItem();
          if (!next) return;
          if (!cliDispatchQueuedItem(next, "auto")) { cliQueue.unshift(next); return; }
        }
      }, 3000);
    }
  } else if (state === "trust") {
    cliStatus = "working";
    cliSendToTmux("");
    broadcastState();
  } else if (idle && cliStatus === "idle" && hasAutoDispatchableCliQueueItem() && !cliAutoSendPending) {
    const next = takeNextAutoDispatchableCliQueueItem();
    if (!next) return;
    if (!cliDispatchQueuedItem(next, "auto")) { cliQueue.unshift(next); return; }
  } else if (!idle && (cliStatus === "idle" || cliStatus === "disconnected")) {
    cliStatus = "working";
    broadcastState();
  }
}, 2000);
// ─── End CLI Pilot ─────────────────────────────────────────────────────────

function addChat(role, text, extra) {
  const entry = { role, text, time: new Date().toLocaleTimeString(), ts: Date.now(), ...extra };
  chatLog.push(entry);
  if (chatLog.length > 500) chatLog.shift();
  broadcast({ type: "chat", entry });
  // Persist user/brain messages (skip noisy system/sent/error for disk)
  if (role === "user" || role === "brain") saveChatLog();
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// Update a finding card's status badge in-place (no new chat message)
function broadcastFindingUpdate(id, status, extra) {
  broadcast({ type: "findingUpdate", id, status, ...extra });
}

function buildStatePayload() {
  reloadFindingsFromDisk();
  primePromptProvenanceForStartupState();
  const currentRepoCandidate = getCurrentRepoCandidate();
  const threadDigest = loadKnowledge().threadDigest;
  return {
    type: "state",
    running,
    state,
    cycleCount,
    interval: settings.interval,
    uptime: Date.now() - startTime,
    memoryFiles: memoryFileCount,
    runtimeAgent: RUNTIME_AGENT_LABEL,
    importedHistoryAgents: listImportedHistoryAgents(),
    importedHistorySummary: summarizeImportedHistoryForUI(),
    threadScanStats: threadDigest.stats,
    voiceProfileMeta: getVoiceProfileMeta(),
    observeOnly: activeProjects.length === 0,
    currentRepoCandidate,
    brainModel: BRAIN_MODEL,
    guidance: userGuidance,
    activeProjects,
    allProjects: listSelectableProjects(currentRepoCandidate),
    cycleHistory,
    findings,
    filesInvestigated,
    continueQueue,
    screenshotDisabled,
    screenshotMode: lastScreenshotMode || "unknown",
    screenshotPromptMode: lastCycleConversationSnapshotMode || "unprepared",
    screenshotPromptReason: lastCycleConversationSnapshotReason || "",
    chatBusy,
    controlTraffic,
    promptProvenance,
    muteMode,
    queuedFindings: findings.filter(f => f.status === "queued").length,
    goals: goalsData,
    cli: { queue: cliQueue, history: cliHistory, status: cliStatus, autoMode: cliAutoMode, session: CLI_SESSION },
  };
}

function broadcastState() {
  broadcast(buildStatePayload());
}

// Get the Codex desktop window ID for focused screenshots.
async function getAppWindowId() {
  try {
    const scriptFile = path.join(TMP_DIR, "winid.js");
    const jxa = `ObjC.import('CoreGraphics');
var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
var result = '';
for (var i = 0; i < list.length; i++) {
  if (list[i].kCGWindowOwnerName === '${APP_NAME}' && list[i].kCGWindowLayer === 0) {
    result = '' + list[i].kCGWindowNumber;
    break;
  }
}
result;`;
    fs.writeFileSync(scriptFile, jxa);
    const { stdout } = await execAsync(`osascript -l JavaScript "${scriptFile}"`, { timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getAppWindowBounds() {
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to tell process "${APP_NAME}" to get position of window 1 & size of window 1'`,
      { timeout: 3000 }
    );
    const parts = String(stdout || "").match(/-?\d+/g)?.map(Number) || [];
    if (parts.length >= 4) {
      const [x, y, width, height] = parts;
      return { x, y, width, height };
    }
  } catch {}
  return null;
}

let screenshotDisabled = false;
let screenshotFailCount = 0;
let lastScreenshotMode = "unknown";
let lastCycleConversationSnapshotText = `Screenshot of ${APP_NAME} is at ${SCREENSHOT_PATH} — read it to see the current state.`;
let lastCycleConversationSnapshotMode = "unprepared";
let lastCycleConversationSnapshotReason = "";
let lastCycleConversationHash = null;
let lastCycleConversationOcrFingerprint = "";

async function takeScreenshot() {
  if (screenshotDisabled) return null;
  try {
    const wid = await getAppWindowId();
    const bounds = wid ? null : await getAppWindowBounds();
    lastScreenshotMode = (wid || bounds) ? `${APP_NAME} window` : "full screen";
    const cmd = wid
      ? `screencapture -x -t png -l${wid} "${SCREENSHOT_PATH}"`
      : bounds
      ? `screencapture -x -t png -R"${bounds.x},${bounds.y},${bounds.width},${bounds.height}" "${SCREENSHOT_PATH}"`
      : `screencapture -x -t png "${SCREENSHOT_PATH}"`;

    const SYSTEM_NODE = "/opt/homebrew/bin/node";
    const isElectron = !!process.versions.electron;
    if (isElectron && fs.existsSync(SYSTEM_NODE)) {
      await execAsync(`${SYSTEM_NODE} -e "require('child_process').execSync('${cmd}', {timeout: 5000})"`, { timeout: 8000 });
    } else {
      await execAsync(cmd, { timeout: 5000 });
    }
    screenshotFailCount = 0;
    const buf = fs.readFileSync(SCREENSHOT_PATH);
    return buf;
  } catch (e) {
    screenshotFailCount++;
    if (screenshotFailCount >= 3) {
      screenshotDisabled = true;
      addChat("system", "Screenshots disabled — grant Screen Recording permission to 'node' in System Settings.");
    } else {
      addChat("system", "Screenshot failed: " + e.message);
    }
    return null;
  }
}

// Quick idle check via screenshot hash — requires 2 consecutive changes to declare busy
// (debounces cursor blinks, clock ticks, and minor UI updates)
let lastScreenshotHash = null;
let consecutiveChanges = 0;
let lastFullScreenshotHash = null;
let lastOcrImageHash = null;
let lastOcrText = "";

function normalizeCycleOcrText(text) {
  return String(text || "").replace(/\n{3,}/g, "\n\n").replace(/\s+/g, " ").trim();
}

function hasPendingDesktopVisualReceiptNeed() {
  return findings.some((finding) => finding.status === "sent" && finding.sendTarget === "desktop" && !isSyntheticBenchmarkFinding(finding));
}

function didCycleUiMateriallyChange(fullHash, normalizedOcr) {
  if (!normalizedOcr) return false;
  if (!lastCycleConversationHash && !lastCycleConversationOcrFingerprint) return false;
  if (lastCycleConversationOcrFingerprint) {
    if (similarity(normalizedOcr, lastCycleConversationOcrFingerprint) >= 0.84) return false;
    if (fullHash && lastCycleConversationHash && fullHash === lastCycleConversationHash) return false;
    return true;
  }
  return !!(fullHash && lastCycleConversationHash && fullHash !== lastCycleConversationHash);
}

function readScreenshotTextWithOcr(screenshotPath, imageHash) {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) return "";
  if (imageHash && imageHash === lastOcrImageHash) return lastOcrText;

  try {
    const helperPath = ensureOcrHelperScript();
    const output = execFileSync("swift", [helperPath, screenshotPath], {
      encoding: "utf8",
      timeout: 12000,
      maxBuffer: 1024 * 1024,
    }).trim();
    lastOcrImageHash = imageHash || null;
    lastOcrText = output;
    return output;
  } catch (e) {
    console.log("[ocr] Failed to read screenshot text:", e.message);
    return "";
  }
}

function screenshotShowsCodexBusyState(screenshotPath, imageHash) {
  const ocrText = readScreenshotTextWithOcr(screenshotPath, imageHash);
  if (!ocrText) return false;

  const normalized = ocrText.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  return compact.includes("thinking")
    || compact.includes("runningcommand")
    || /running\s+\d+\s+terminals?/i.test(normalized)
    || /running command for \d+/i.test(normalized);
}

async function isDesktopIdle(screenshotBuf) {
  // If we couldn't capture the app window specifically, we can't reliably
  // detect idle state — the bottom 200px would be wallpaper, not the input area.
  // Fall back to "assume idle" and let dedup/cooldown guards prevent spam.
  if (lastScreenshotMode === "full screen") {
    return true;
  }

  const fullHash = crypto.createHash("md5").update(screenshotBuf).digest("hex");
  lastFullScreenshotHash = fullHash;

  // Crop to bottom 200px (input area) to ignore clock/menu bar changes
  let hashBuf = screenshotBuf;
  try {
    const meta = await sharp(screenshotBuf).metadata();
    const cropHeight = Math.min(200, meta.height);
    const top = meta.height - cropHeight;
    hashBuf = await sharp(screenshotBuf)
      .extract({ left: 0, top, width: meta.width, height: cropHeight })
      .toBuffer();
  } catch (e) {
    // Fall back to full screenshot if crop fails
  }

  const hash = crypto.createHash("md5").update(hashBuf).digest("hex");

  if (APP_NAME === "Codex" && screenshotShowsCodexBusyState(SCREENSHOT_PATH, fullHash)) {
    console.log("Idle check: Codex OCR indicates busy UI");
    lastScreenshotHash = hash;
    consecutiveChanges = 0;
    return false;
  }

  if (!lastScreenshotHash) {
    lastScreenshotHash = hash;
    return true;
  }

  const changed = hash !== lastScreenshotHash;
  lastScreenshotHash = hash;

  if (!changed) {
    consecutiveChanges = 0;
    return true;
  }

  consecutiveChanges++;
  // Only declare busy after 2+ consecutive changes (streaming produces continuous changes)
  if (consecutiveChanges >= 2) {
    console.log(`Idle check: ${consecutiveChanges} consecutive changes — busy`);
    return false;
  }

  return true; // Single change — likely cursor blink or minor update
}

async function prepareCycleConversationSnapshot(screenshotBuf, options = {}) {
  const fullHash = lastFullScreenshotHash || crypto.createHash("md5").update(screenshotBuf).digest("hex");
  const rawOcrText = readScreenshotTextWithOcr(SCREENSHOT_PATH, fullHash)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const ocrText = rawOcrText ? rawOcrText.slice(0, 1200) : "";
  const normalizedOcr = normalizeCycleOcrText(rawOcrText).slice(0, 1500);
  const needsExactVisualProof = options.forceRich === true || hasPendingDesktopVisualReceiptNeed();
  const materiallyChanged = didCycleUiMateriallyChange(fullHash, normalizedOcr);
  const receiptOnlyBusyConversation = options.receiptOnlyBusyConversation === true;
  const needsRichImage = needsExactVisualProof || materiallyChanged;

  let promptText = "";
  let promptMode = "ocr-only";
  let promptReason = "stable OCR snapshot";

  if (receiptOnlyBusyConversation && !needsExactVisualProof) {
    promptMode = "busy-receipt-only";
    promptReason = "desktop conversation is busy; ignore topical content";
    promptText = `Current ${APP_NAME} desktop window is busy with a live conversation. Treat the desktop window as busy-state evidence only. Do NOT use its topical content as the active work item. Focus on project context, goals, findings, and dedicated CLI state instead.`;
  } else if (!needsRichImage && ocrText) {
    promptText = `Current ${APP_NAME} window OCR snapshot:\n${ocrText}`;
  } else {
    const outputPath = needsRichImage ? RICH_CYCLE_SCREENSHOT_PATH : LIGHT_CYCLE_SCREENSHOT_PATH;
    const variantPath = await writeCycleScreenshotVariant(screenshotBuf, {
      outputPath,
      width: needsRichImage ? 768 : 320,
      quality: needsRichImage ? 55 : 28,
    });
    const chosenPath = variantPath || SCREENSHOT_PATH;

    if (needsExactVisualProof) {
      promptMode = receiptOnlyBusyConversation ? "busy-rich-proof" : "rich-proof";
      promptReason = receiptOnlyBusyConversation
        ? "desktop conversation is busy; visual proof is needed only for exact receipt checks"
        : "exact visual receipt proof is needed";
    } else if (materiallyChanged) {
      promptMode = "rich-change";
      promptReason = "the UI materially changed since the last cycle";
    } else {
      promptMode = "light-image";
      promptReason = "OCR text was unavailable";
    }

    promptText = [
      receiptOnlyBusyConversation
        ? `Current ${APP_NAME} desktop window is busy with a live conversation. Treat the desktop window as receipt/busy-state evidence only. Do NOT use its topical content as the active work item.`
        : null,
      ocrText ? `OCR text from the current ${APP_NAME} window:\n${ocrText}` : null,
      `${needsRichImage ? "Rich screenshot" : "Lightweight screenshot"} of ${APP_NAME} is at ${chosenPath} — inspect it because ${promptReason}.`,
    ].filter(Boolean).join("\n\n");
  }

  lastCycleConversationSnapshotText = promptText || `Screenshot of ${APP_NAME} is at ${SCREENSHOT_PATH} — read it to see the current state.`;
  lastCycleConversationSnapshotMode = promptMode;
  lastCycleConversationSnapshotReason = promptReason;
  lastCycleConversationHash = fullHash;
  lastCycleConversationOcrFingerprint = normalizedOcr;
  console.log(`[cycle] Visual context: ${promptMode}${promptReason ? ` — ${promptReason}` : ""}`);
}

function buildCycleConversationSnapshot() {
  return lastCycleConversationSnapshotText || `Screenshot of ${APP_NAME} is at ${SCREENSHOT_PATH} — read it to see the current state.`;
}

function buildCliDeliveryContext() {
  if (!shouldPreferCliDelivery()) return "";
  const queueItems = cliQueue
    .filter((item) => item?.text)
    .slice(0, 3)
    .map((item, index) => {
      const label = item.title || item.findingId || `queued-${index + 1}`;
      const prompt = String(item.originalText || item.prompt || item.text || "").replace(/^autopilot:\s*/i, "");
      return `${index + 1}. ${label} — "${prompt.slice(0, 140)}"`;
    });

  const screen = cliCapturePane() || cliLastScreen || "";
  const trimmedScreen = screen
    .split("\n")
    .slice(-24)
    .join("\n")
    .trim()
    .slice(-1400);

  const lines = [
    `## Dedicated CLI Delivery`,
    `Status: ${cliStatus}. Queue: ${cliQueue.length}. Auto-dispatch: ${cliAutoMode ? "on" : "off"}. Session: ${CLI_SESSION}.`,
  ];

  if (queueItems.length > 0) {
    lines.push(`Queued items:\n${queueItems.map((line) => `- ${line}`).join("\n")}`);
  }

  if (trimmedScreen) {
    lines.push(`CLI terminal snapshot (latest pane tail):\n\`\`\`\n${trimmedScreen}\n\`\`\``);
  }

  if (cliStatus === "working") {
    lines.push(`When desktop ${APP_NAME} is busy, prefer this dedicated CLI state over desktop topical text for delivery/runtime truth.`);
  }

  return lines.join("\n");
}

let lastSendTime = 0;
const SEND_COOLDOWN_MS = 60000; // Don't send within 60s of last send
let lastExactSendText = ""; // Exact-match dedup — blocks identical resends for 5 min
let lastExactSendTime = 0;
// pendingSend removed — deferred sends now live on findings as pendingPrompt

function shouldPreferCliDelivery() {
  return APP_NAME === "Codex" && DELIVERY_TARGET !== "desktop";
}

function shortSendAttemptId(attemptId) {
  if (!attemptId) return "";
  const raw = String(attemptId);
  return raw.length > 10 ? raw.slice(-10) : raw;
}

function createSendAttemptId(findingId) {
  const prefix = findingId || "direct";
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildFindingSendContext(finding, prompt = null) {
  if (!finding || !finding.id) return null;
  return {
    id: finding.id,
    type: finding.type || "message",
    title: finding.title,
    detail: finding.detail,
    file: finding.file,
    project: finding.project,
    prompt: prompt || finding.sentPrompt || finding.pendingPrompt || null,
    attemptId: createSendAttemptId(finding.id),
  };
}

function findFindingMessage(finding, prompt, attemptId) {
  if (!Array.isArray(finding?.messages)) return null;
  for (let i = finding.messages.length - 1; i >= 0; i--) {
    const message = finding.messages[i];
    if (!message?.text) continue;
    if (attemptId && message.sendAttemptId === attemptId) return message;
    if (prompt && message.text === prompt) return message;
  }
  return null;
}

function ensureFindingMessage(finding, prompt, attemptId) {
  if (!prompt) return null;
  if (!Array.isArray(finding.messages)) finding.messages = [];
  let message = findFindingMessage(finding, prompt, attemptId);
  if (!message) {
    message = { text: prompt, status: "pending", addedAt: new Date().toISOString() };
    finding.messages.push(message);
  }
  return message;
}

function buildFindingStatusBroadcastExtra(finding, promptOverride = null) {
  return {
    prompt: promptOverride ?? finding?.sentPrompt ?? finding?.pendingPrompt ?? null,
    sendTarget: finding?.sendTarget || null,
    sendAttemptId: finding?.sendAttemptId || null,
    sentAt: finding?.sentAt || null,
    receivedAt: finding?.receivedAt || null,
    receiptSource: finding?.receiptSource || null,
    receiptEvidence: finding?.receiptEvidence || null,
    deliveryObservedAt: finding?.deliveryObservedAt || null,
    deliveryObservedSource: finding?.deliveryObservedSource || null,
  };
}

function noteSendVerification(outcome, options = {}) {
  if (options.consumePending !== false && sendsPending > 0) sendsPending--;
  if (outcome === "delivered") sendsDelivered++;
  if (outcome === "ignored") sendsIgnored++;
}

function applySendResultToFindingRecord(finding, prompt, sendResult) {
  if (!finding || !sendResult || !sendResult.ok) return;
  const attemptId = sendResult.attemptId || finding.sendAttemptId || null;
  if (sendResult.receipt === "queued") {
    finding.status = "queued";
    finding.pendingPrompt = prompt;
    finding.sendTarget = sendResult.target || finding.sendTarget || null;
    if (attemptId) finding.sendAttemptId = attemptId;
    pruneCliQueueForFinding(finding.id, attemptId);

    const queuedMsg = ensureFindingMessage(finding, prompt, attemptId);
    if (queuedMsg) {
      queuedMsg.status = "queued";
      if (attemptId) queuedMsg.sendAttemptId = attemptId;
      delete queuedMsg.sentAt;
      delete queuedMsg.receivedAt;
      delete queuedMsg.receiptSource;
      delete queuedMsg.receiptEvidence;
    }
    reconcileQueuedMessagesForFinding(finding);
    return;
  }

  const nowIso = new Date().toISOString();
  pruneCliQueueForFinding(finding.id, attemptId);
  finding.sentPrompt = prompt;
  finding.sentAt = Date.now();
  finding.sendTarget = sendResult.target || null;
  if (attemptId) finding.sendAttemptId = attemptId;
  delete finding.pendingPrompt;
  delete finding.receivedAt;
  delete finding.receiptSource;
  delete finding.receiptEvidence;
  delete finding.deliveryObservedAt;
  delete finding.deliveryObservedSource;

  const msg = ensureFindingMessage(finding, prompt, attemptId);
  if (msg) {
    msg.status = sendResult.receipt === "received" ? "received" : "sent";
    msg.sentAt = nowIso;
    if (attemptId) msg.sendAttemptId = attemptId;
    delete msg.receivedAt;
    delete msg.receiptSource;
    delete msg.receiptEvidence;
    if (sendResult.receipt === "received") {
      msg.receivedAt = nowIso;
      if (sendResult.receiptSource) msg.receiptSource = sendResult.receiptSource;
      if (sendResult.receiptEvidence) msg.receiptEvidence = sendResult.receiptEvidence;
    }
  }

  if (sendResult.receipt === "received") {
    finding.status = "received";
    finding.receivedAt = nowIso;
    finding.receiptSource = sendResult.receiptSource || null;
    finding.receiptEvidence = sendResult.receiptEvidence || null;
  } else {
    finding.status = "sent";
  }
  reconcileQueuedMessagesForFinding(finding);
}

function markFindingQueued(findingId, details = {}) {
  if (!findingId) return false;
  reloadFindingsFromDisk();
  const finding = findings.find(f => f.id === findingId);
  if (!finding) return false;
  if (details.attemptId && finding.sendAttemptId && finding.sendAttemptId !== details.attemptId) return false;

  const prompt = details.prompt || finding.pendingPrompt || finding.sentPrompt || null;
  pruneCliQueueForFinding(findingId, details.attemptId || null);
  finding.status = "queued";
  if (prompt) finding.pendingPrompt = prompt;
  if (details.target || finding.sendTarget) finding.sendTarget = details.target || finding.sendTarget || "cli";
  if (details.attemptId) finding.sendAttemptId = details.attemptId;
  if (details.source) finding.lastIgnoredSource = details.source;
  if (details.evidence) finding.lastIgnoredEvidence = details.evidence;
  finding.lastIgnoredAt = new Date().toISOString();
  delete finding.sentAt;
  delete finding.receivedAt;
  delete finding.receiptSource;
  delete finding.receiptEvidence;
  delete finding.deliveryObservedAt;
  delete finding.deliveryObservedSource;

  const msg = ensureFindingMessage(finding, prompt, details.attemptId || null);
  if (msg) {
    msg.status = "queued";
    if (details.attemptId) msg.sendAttemptId = details.attemptId;
    delete msg.sentAt;
    delete msg.receivedAt;
    delete msg.receiptSource;
    delete msg.receiptEvidence;
  }

  reconcileQueuedMessagesForFinding(finding);

  saveFindings();
  broadcastFindingUpdate(finding.id, "queued", buildFindingStatusBroadcastExtra(finding, prompt));
  broadcastState();
  return true;
}

function resolveReceiptAttempt(explicitFindingId, explicitAttemptId) {
  const findingId = explicitFindingId || lastSentFindingId || null;
  const attemptId = explicitAttemptId || lastSentAttemptId || null;
  if (!findingId) return null;
  reloadFindingsFromDisk();
  const finding = findings.find(f => f.id === findingId);
  if (!finding) return null;
  if (attemptId && finding.sendAttemptId && finding.sendAttemptId !== attemptId) return null;
  if (attemptId && !finding.sendAttemptId) return null;
  return { findingId, attemptId: attemptId || finding.sendAttemptId || null };
}

function markFindingReceived(findingId, details = {}) {
  if (!findingId) return false;
  reloadFindingsFromDisk();
  const finding = findings.find(f => f.id === findingId);
  if (!finding || finding.status !== "sent") return false;
  if (details.attemptId && finding.sendAttemptId && finding.sendAttemptId !== details.attemptId) return false;
  if (details.attemptId && !finding.sendAttemptId) return false;
  if (details.prompt && finding.sentPrompt && finding.sentPrompt !== details.prompt) return false;
  const nowIso = details.receivedAt || new Date().toISOString();
  pruneCliQueueForFinding(findingId, details.attemptId || null);
  finding.status = "received";
  finding.receivedAt = nowIso;
  if (details.source) finding.receiptSource = details.source;
  if (details.evidence) finding.receiptEvidence = details.evidence;
  if (details.target) finding.sendTarget = details.target;
  const msg = findFindingMessage(finding, finding.sentPrompt, details.attemptId);
  if (msg) {
    msg.status = "received";
    msg.receivedAt = nowIso;
    if (details.attemptId) msg.sendAttemptId = details.attemptId;
    if (finding.receiptSource) msg.receiptSource = finding.receiptSource;
    if (finding.receiptEvidence) msg.receiptEvidence = finding.receiptEvidence;
  }
  reconcileQueuedMessagesForFinding(finding);
  saveFindings();
  broadcastFindingUpdate(finding.id, "received", buildFindingStatusBroadcastExtra(finding));
  broadcastState();
  return true;
}

function revertSentFindingToQueue(findingId, details = {}) {
  if (!findingId) return false;
  reloadFindingsFromDisk();
  const finding = findings.find(f => f.id === findingId);
  if (!finding || finding.status !== "sent") return false;
  if (details.attemptId && finding.sendAttemptId && finding.sendAttemptId !== details.attemptId) return false;
  if (details.attemptId && !finding.sendAttemptId) return false;
  if (details.prompt && finding.sentPrompt && finding.sentPrompt !== details.prompt) return false;
  pruneCliQueueForFinding(findingId, details.attemptId || null);
  finding.status = "identified";
  finding.pendingPrompt = finding.sentPrompt || details.message || finding.pendingPrompt;
  finding.retryCount = (finding.retryCount || 0) + (details.incrementRetry === false ? 0 : 1);
  if (finding.retryCount > 3) finding.status = "failed";
  if (details.source) finding.lastIgnoredSource = details.source;
  if (details.evidence) finding.lastIgnoredEvidence = details.evidence;
  finding.lastIgnoredAt = new Date().toISOString();
  delete finding.receivedAt;
  delete finding.receiptSource;
  delete finding.receiptEvidence;
  delete finding.deliveryObservedAt;
  delete finding.deliveryObservedSource;
  delete finding.sendAttemptId;
  const msg = findFindingMessage(finding, finding.sentPrompt, details.attemptId);
  if (msg) {
    msg.status = "pending";
    delete msg.sentAt;
    delete msg.receivedAt;
    delete msg.receiptSource;
    delete msg.receiptEvidence;
    delete msg.sendAttemptId;
  }
  reconcileQueuedMessagesForFinding(finding);
  saveFindings();
  broadcastFindingUpdate(finding.id, finding.status, buildFindingStatusBroadcastExtra(finding, finding.pendingPrompt || finding.sentPrompt || null));
  broadcastState();
  return true;
}

function recordSuccessfulSend(message, findingCtx, options = {}) {
  lastSentMessage = message;
  lastSentFindingId = findingCtx?.id || null;
  lastSentAttemptId = findingCtx?.attemptId || null;
  lastSentTarget = options.target || null;
  lastSendFailed = false;
  lastSendTime = Date.now();
  lastExactSendText = message;
  lastExactSendTime = Date.now();
  if (options.receiptConfirmed) sendsDelivered++;
  else sendsPending++;
  sentHistory.unshift(message);
  if (sentHistory.length > 10) sentHistory.pop();
  try { atomicWriteSync(SENT_HISTORY_FILE, JSON.stringify(sentHistory, null, 2)); } catch {}
}

async function sendToCliTarget(message, findingCtx) {
  const ready = await ensureCliSessionReady({ requireIdle: true, autoStart: true, timeoutMs: 20000 });
  if (!ready) {
    const screen = cliCapturePane();
    const state = cliScreenState(screen);
    if (findingCtx?.id && state !== "disconnected") {
      console.log(`[send] Codex CLI ${state} — queued for dedicated delivery${cliAutoMode ? "" : " (auto-send off)"}`);
      return queueCliDelivery(message, findingCtx, {
        originalText: findingCtx.prompt || message,
        prompt: findingCtx.prompt || message,
      });
    }
    console.log("[send] Codex CLI session not ready");
    return { ok: false };
  }

  const beforeScreen = cliCapturePane();
  if (!cliSendToTmux(message)) {
    console.log("[send] Failed to send to Codex CLI tmux session");
    return { ok: false };
  }

  cliHistory.push({ text: message, time: new Date().toLocaleTimeString(), type: "auto" });
  if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
  cliStatus = "working";
  cliSaveState();
  broadcastState();

  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 500));
    const screen = cliCapturePane();
    const state = cliScreenState(screen);
    if (screen && screen !== cliLastScreen) {
      cliLastScreen = screen;
      broadcast({ type: "cli_terminal", content: screen });
    }
    if (state === "working") {
      return {
        ok: true,
        target: "cli",
        receipt: "received",
        receiptSource: "cli-working",
        receiptEvidence: "Dedicated Codex CLI accepted the prompt and entered a working state.",
      };
    }
    if (state === "idle" && screen && screen !== beforeScreen && !cliPromptContainsMessage(screen, message)) {
      return {
        ok: true,
        target: "cli",
        receipt: "received",
        receiptSource: "cli-accepted",
        receiptEvidence: "Dedicated Codex CLI accepted the prompt and cleared it from the input line.",
      };
    }
    if (state === "trust") {
      cliSendToTmux("");
    }
  }

  if (findingCtx) {
    addChat("system", `CLI send may not have landed — "${message.slice(0, 60)}..." stayed idle.`);
  }
  return { ok: false };
}

async function verifyDesktopSend(message, findingCtx) {
  try {
    const preSendHash = lastScreenshotHash || null;
    const buf = await takeScreenshot();
    if (!buf) return;
    fs.writeFileSync(SCREENSHOT_PATH, buf);
    const postHash = crypto.createHash("md5").update(buf).digest("hex");
    const delivered = preSendHash ? postHash !== preSendHash : null;
    console.log(`[send] Post-send: UI ${delivered === null ? "unverifiable" : delivered ? "changed" : "unchanged"}`);
    if (delivered === true && findingCtx?.id) {
      const applied = markFindingReceived(findingCtx.id, {
        attemptId: findingCtx.attemptId,
        prompt: message,
        source: "desktop-ui-change",
        evidence: "Desktop UI changed right after the exact send attempt, indicating the prompt landed.",
        target: "desktop",
      });
      if (applied) noteSendVerification("delivered");
      return;
    }
    if (delivered === false && findingCtx?.id) {
      const reverted = revertSentFindingToQueue(findingCtx.id, {
        attemptId: findingCtx.attemptId,
        prompt: message,
        source: "desktop-ui-unchanged",
        evidence: "Desktop UI did not change after the exact send attempt.",
      });
      if (reverted) {
        noteSendVerification("ignored");
        reloadFindingsFromDisk();
        const finding = findings.find(f => f.id === findingCtx.id);
        if (finding?.status === "failed") {
          addChat("system", `Message failed after 3 retries: "${message.slice(0, 60)}..."`);
        } else if (finding) {
          addChat("system", `Message may not have landed — will retry next cycle (attempt ${finding.retryCount || 1}/3)`);
        }
      }
    }
  } catch (e) {
    console.log("[send] Post-send screenshot failed: " + e.message);
  }
}

async function sendToApp(message, findingCtx) {
  try {
    // Mute mode is now handled at the pipeline level (before sendToApp is called)
    // This is a safety fallback — pipeline should never call sendToApp while muted
    if (muteMode) {
      console.log("[sendToApp] Called while muted — pipeline should handle this. Skipping.");
      return { ok: false };
    }
    // Exact-match dedup: block identical messages within 5 minutes
    if (message === lastExactSendText && Date.now() - lastExactSendTime < 300000) {
      console.log("[send] Blocked exact duplicate");
      return { ok: false };
    }
    // Similarity dedup: block similar messages
    if (isDuplicate(message)) {
      console.log("[send] Blocked similar duplicate: " + message.slice(0, 60));
      return { ok: false };
    }
    // Cooldown: skip send if too soon — next cycle will retry
    const timeSinceLastSend = Date.now() - lastSendTime;
    if (timeSinceLastSend < SEND_COOLDOWN_MS) {
      console.log(`[send] Cooldown — ${Math.ceil((SEND_COOLDOWN_MS - timeSinceLastSend) / 1000)}s remaining`);
      return { ok: false };
    }

    const prefixed = "autopilot: " + message;
    if (shouldPreferCliDelivery()) {
      const cliResult = await sendToCliTarget(prefixed, findingCtx);
      if (cliResult.ok) {
        cliResult.attemptId = findingCtx?.attemptId || null;
        if (cliResult.receipt === "received") {
          recordSuccessfulSend(message, findingCtx, { target: "cli", receiptConfirmed: true });
        }
        return cliResult;
      }
      if (DELIVERY_TARGET === "cli") return { ok: false };
    }

    await new Promise((resolve, reject) => {
      const SYSTEM_NODE = "/opt/homebrew/bin/node";
      const isElectron = !!process.versions.electron;
      if (isElectron && fs.existsSync(SYSTEM_NODE)) {
        // Write a temp script to avoid shell quoting issues with arbitrary message text
        const tmpScript = path.join(TMP_DIR, "send-cmd.js");
        fs.writeFileSync(tmpScript, `require("child_process").execFileSync("python3", [${JSON.stringify(SEND_SCRIPT)}, ${JSON.stringify(prefixed)}], {timeout: 15000});`);
        execFile(SYSTEM_NODE, [tmpScript], { timeout: 20000 }, (err, stdout, stderr) => {
          if (stderr) console.log("[send] send_to_codex.py stderr: " + stderr.trim());
          if (err) reject(err); else resolve();
        });
      } else {
        execFile("python3", [SEND_SCRIPT, prefixed], { timeout: 15000 }, (err, stdout, stderr) => {
          if (stderr) console.log("[send] send_to_codex.py stderr: " + stderr.trim());
          if (err) reject(err); else resolve();
        });
      }
    });
    recordSuccessfulSend(message, findingCtx, { target: "desktop", receiptConfirmed: false });

    // Capture post-send screenshot — if UI unchanged, message may have been
    // intercepted (e.g. user's computer use grabbed focus). Reset finding to
    // retry on next cycle.
    setTimeout(async () => {
      await verifyDesktopSend(message, findingCtx);
    }, 5000);
    return { ok: true, target: "desktop", receipt: "sent", attemptId: findingCtx?.attemptId || null };
  } catch (e) {
    lastSendFailed = true;
    addChat("error", "Send failed: " + e.message + (e.stderr ? "\nstderr: " + e.stderr.trim() : ""));
    return { ok: false };
  }
}

// Gather live project context for the brain (cached every 3rd cycle)
let cachedProjectCtx = null;
let lastProjectCtxCycle = 0;
function gatherProjectContext() {
  if (cachedProjectCtx && cycleCount - lastProjectCtxCycle < 3) {
    return cachedProjectCtx;
  }
  const ctx = {};

  // Current working directory + last edited file — read from cached thread digest
  try {
    const digest = loadKnowledge().threadDigest;
    const sessions = Object.entries(digest.sessions || {})
      .sort((a, b) => (b[1].scannedAt || 0) - (a[1].scannedAt || 0));
    for (const [, session] of sessions) {
      if (session.cwd && !ctx.cwd) ctx.cwd = session.cwd;
      if (session.lastEditedFile && !ctx.lastEditedFile) ctx.lastEditedFile = session.lastEditedFile;
      if (ctx.cwd && ctx.lastEditedFile) break;
    }
  } catch {}

  // If CWD is not a git repo, find the most recently active git project subdirectory
  if (ctx.cwd && fs.existsSync(ctx.cwd) && !fs.existsSync(path.join(ctx.cwd, ".git"))) {
    try {
      const subdirs = fs.readdirSync(ctx.cwd)
        .filter(d => {
          try {
            const full = path.join(ctx.cwd, d);
            return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, ".git"));
          } catch { return false; }
        });
      // Pick the one with the most recent .git/HEAD mtime
      let best = null, bestMtime = 0;
      for (const d of subdirs) {
        try {
          const headPath = path.join(ctx.cwd, d, ".git", "HEAD");
          const mtime = fs.statSync(headPath).mtimeMs;
          if (mtime > bestMtime) { bestMtime = mtime; best = d; }
        } catch {}
      }
      if (best) {
        ctx.cwd = path.join(ctx.cwd, best);
        ctx.cwdResolved = true; // flag that we auto-detected the project
      }
    } catch {}
  }

  // Recent git status and log from the active project
  if (ctx.cwd && fs.existsSync(ctx.cwd) && fs.existsSync(path.join(ctx.cwd, ".git"))) {
    try {
      ctx.gitStatus = execFileSync("git", ["status", "--short"], { cwd: ctx.cwd, timeout: 3000, encoding: "utf8" }).trim().slice(0, 500);
    } catch {}
    try {
      ctx.gitLog = execFileSync("git", ["log", "--oneline", "-5"], { cwd: ctx.cwd, timeout: 3000, encoding: "utf8" }).trim();
    } catch {}
    try {
      ctx.gitDiff = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd: ctx.cwd, timeout: 3000, encoding: "utf8" }).trim().slice(0, 500);
    } catch {}
    // Get file tree (top-level only, skip node_modules etc)
    try {
      const tree = execFileSync("find", [".", "-maxdepth", "2", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/.next/*"], { cwd: ctx.cwd, timeout: 3000, encoding: "utf8" });
      ctx.fileTree = tree.split("\n").slice(0, 60).join("\n").trim();
    } catch {}
  }

  // Check for recent errors in common log locations
  try {
    const errLog = execSync(`tail -20 ${TMP_DIR}/*.log 2>/dev/null || true`, { timeout: 2000 }).toString().trim();
    if (errLog) ctx.recentErrors = errLog.slice(0, 400);
  } catch {}

  cachedProjectCtx = ctx;
  lastProjectCtxCycle = cycleCount;
  return ctx;
}

// Build prompt for chat — lightweight, conversational, includes history
function buildChatPrompt(userMessage) {
  const prompt = createPromptAssembler();
  const isResume = !!chatSessionId;
  const importedHistoryAgents = listImportedHistoryAgents();

  // On first message in a new chat session, give full context
  if (!isResume) {
    prompt.add("screenshot", "screenshot", `Screenshot of ${APP_NAME} is at ${SCREENSHOT_PATH} — read it to see the current state.`, { kind: "visual" });
    prompt.add("runtimeIdentity", "runtime identity", buildRuntimeIdentitySection(), { kind: "identity" });

    // Autopilot memory
    try {
      const mem = getAutopilotMemoryMarkdown().trim();
      if (mem) prompt.add("autopilotMemory", "autopilot memory", `## YOUR MEMORY\n${mem}`, { kind: "memory" });
    } catch {}

    // Brief project context
    const projectCtx = gatherProjectContext();
    const projectBits = [];
    if (projectCtx.cwd) projectBits.push(`Working directory: ${projectCtx.cwd}`);
    if (projectCtx.gitLog) projectBits.push(`Recent commits:\n${projectCtx.gitLog}`);
    if (projectBits.length) prompt.add("projectContext", "project context", projectBits.join("\n"), { kind: "context" });

    if (userGuidance) {
      prompt.add("mission", "user mission", `USER MISSION: "${userGuidance}" — Manifest the user's implicit goals, extend them into actionable steps, and drive progress toward this mission.`, { kind: "guidance" });
    }

    // Carry forward conversation summary from previous session
    if (chatSummary) prompt.add("chatSummary", "prior chat summary", formatChatSummaryForPrompt(chatSummary), { kind: "history" });
  }

  // Conversation history — the brain sees what was said before
  const recentChat = chatLog
    .filter(m => m.role === "user" || m.role === "brain")
    .slice(-20) // last 20 exchanges
    .map(m => `[${m.role === "user" ? "USER" : RUNTIME_AGENT_LABEL.toUpperCase()} ${m.time}] ${m.text.slice(0, 500)}`)
    .join("\n");

  if (recentChat && isResume) {
    // On resume, history is already in the session — just include recent for reference
    prompt.add("recentConversation", "recent conversation reference", `Recent conversation (for reference):\n${recentChat}`, { kind: "reference" });
  } else if (recentChat) {
    prompt.add("conversationHistory", "conversation history", `## Conversation History\n${recentChat}`, { kind: "history" });
  }

  // The actual user message
  prompt.add("userMessage", "user message", `USER: ${userMessage}\n\nRespond naturally. Use tools if needed. End with the JSON block.`, { kind: "instruction" });

  const built = prompt.build();
  if (!isResume) {
    recordPromptProvenance("startup", createPromptProvenanceEntry({
      kind: "startup",
      sessionType: "chat",
      isResume,
      promptText: built.text,
      blocks: built.blocks,
      systemPrompt: CHAT_SYSTEM_PROMPT,
      voiceProfileAttached: CHAT_SYSTEM_PROMPT !== BASE_SYSTEM_PROMPT,
      importedHistoryAgents,
    }));
    broadcastState();
  }

  return built.text;
}

// Build prompt for auto-cycles — full context dump for investigation
// Build goal hierarchy section for brain prompt
function buildGoalSection() {
  if (!goalsData.mission && Object.keys(goalsData.projects).length === 0) return "";

  let section = `## Mission → Goals → Insights\n`;
  if (goalsData.mission) {
    section += `**Mission:** ${goalsData.mission}\n\n`;
  }

  // Show goals grouped by project, with their linked insights
  for (const [projectName, project] of Object.entries(goalsData.projects)) {
    const goals = (project.goals || []).filter((g) => g.status === "active" && !isSyntheticBenchmarkGoal(g));
    if (goals.length === 0) continue;

    // Only show projects the brain cares about
    if (activeProjects.length > 0 && !activeProjects.some(p => projectName.includes(p))) continue;

    section += `### ${projectName}${project.description ? ` — ${project.description}` : ""}\n`;

    for (const goal of goals.sort((a, b) => (a.priority || 99) - (b.priority || 99))) {
      const insightIds = goal.insights || [];
      const linkedInsights = findings.filter((f) => insightIds.includes(f.id) && f.status !== "ignored" && !isSyntheticBenchmarkFinding(f));
      const implemented = linkedInsights.filter(f => f.status === "implemented").length;
      const active = linkedInsights.filter(f => ["identified", "sent", "received"].includes(f.status)).length;

      section += `\n**Goal:** ${goal.title} (${goal.id})\n`;
      section += `  Source: ${describeGoalProvenance(goal)} | Priority: ${goal.priority} | Insights: ${implemented} done, ${active} active\n`;

      if (linkedInsights.length > 0) {
        for (const insight of linkedInsights.slice(0, 4)) {
          section += `  - [${insight.status}] ${insight.title} (${insight.id}) — ${describeInsightProvenance(insight)}\n`;
        }
        if (linkedInsights.length > 4) {
          section += `  - ... and ${linkedInsights.length - 4} more\n`;
        }
      }
    }
    section += "\n";
  }

  // Show unlinked insights count
  const unlinked = goalsData.unlinked_insights || [];
  const unlinkedActive = findings.filter((f) => unlinked.includes(f.id) && f.status !== "ignored" && !isSyntheticBenchmarkFinding(f));
  if (unlinkedActive.length > 0) {
    section += `**Unlinked insights (${unlinkedActive.length}):** These need a goal. Either link them to an existing goal via goalId, or emit a newGoal.\n`;
    for (const insight of unlinkedActive.slice(0, 5)) {
      section += `  - [${insight.status}] ${insight.title} (${insight.id})\n`;
    }
  }

  return section;
}

function buildBrainPrompt(userMessage) {
  const prompt = createPromptAssembler();
  const importedHistoryAgents = listImportedHistoryAgents();
  prompt.add("cycleSnapshot", "visual context", buildCycleConversationSnapshot(), { kind: "visual" });
  prompt.add("runtimeIdentity", "runtime identity", buildRuntimeIdentitySection(), { kind: "identity" });

  const isResume = !STATELESS_AUTO_CYCLES && !!cycleSessionId;

  // User context — skip on resume unless changed or every 5th cycle
  if (userContext && (!isResume || cycleCount <= 1 || userMessage || cycleCount % 5 === 0)) {
    prompt.add("userContext", "imported memory context", `User context from memory files:\n${userContext}`, { kind: "history" });
  } else if (userContext && isResume) {
    prompt.add("userContextUnchanged", "user context unchanged", `[User context unchanged — see previous turn]`, { kind: "reference" });
  }

  // Live project context — always fresh on new session, delta on resume
  const projectCtx = gatherProjectContext();
  if (Object.keys(projectCtx).length > 0) {
    let projectSection = "## Live Project Context\n";
    if (projectCtx.cwd) projectSection += `Working directory: ${projectCtx.cwd}\n`;
    if (projectCtx.lastEditedFile) {
      projectSection += `Last edited file: ${projectCtx.lastEditedFile}\n`;
      // Pre-load active file content to save the brain a tool roundtrip
      try {
        const fullPath = path.isAbsolute(projectCtx.lastEditedFile)
          ? projectCtx.lastEditedFile
          : path.join(projectCtx.cwd || "", projectCtx.lastEditedFile);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const size = fs.statSync(fullPath).size;
          if (size < 30000) { // Only pre-load files under 30KB
            const content = fs.readFileSync(fullPath, "utf8");
            projectSection += `\nActive file contents (${path.basename(fullPath)}):\n\`\`\`\n${content.slice(0, 25000)}\n\`\`\`\n`;
          }
        }
      } catch {}
    }
    if (projectCtx.gitLog) projectSection += `\nRecent commits:\n${projectCtx.gitLog}\n`;
    if (projectCtx.gitStatus) projectSection += `\nUncommitted changes:\n${projectCtx.gitStatus}\n`;
    if (projectCtx.gitDiff) projectSection += `\nDiff stats:\n${projectCtx.gitDiff}\n`;
    if (projectCtx.fileTree) projectSection += `\nProject files:\n${projectCtx.fileTree}\n`;
    if (projectCtx.recentErrors) projectSection += `\nRecent errors:\n${projectCtx.recentErrors}\n`;
    const projectStr = projectSection;
    if (isResume && lastSentProjectCtx === projectStr) {
      prompt.add("projectContextUnchanged", "project context unchanged", `[Project context unchanged — see previous turn]`, { kind: "reference" });
    } else {
      prompt.add("projectContext", "live project context", projectStr, { kind: "context" });
      lastSentProjectCtx = projectStr;
    }
  }

  // Autopilot memory — inject on new session and every 5th cycle
  if (!isResume || cycleCount % 5 === 0) {
    try {
      const mem = getAutopilotMemoryMarkdown().trim();
      if (mem) {
        prompt.add("autopilotMemory", "autopilot memory", `## YOUR MEMORY (autopilot-memory.md) — READ THIS CAREFULLY\nThis memory is persisted by the server, even when your sidecar run is read-only. Decisions recorded here are FINAL. Do not question, revisit, or re-propose anything marked as settled.\n\n${mem}`, { kind: "memory" });
      }
    } catch {}
  }

  // Sent history for dedup awareness
  const visibleSentHistory = sentHistory.filter((message) => !looksLikeSyntheticControlText(message));
  if (visibleSentHistory.length > 0) {
    prompt.add("sentHistory", "sent history", `Messages already sent to ${APP_NAME} (avoid repeating):\n${visibleSentHistory.slice(0, 5).map((m, i) => `${i + 1}. "${m.slice(0, 120)}"`).join("\n")}`, { kind: "history" });
  }

  // Thread digest summary — delta on resume
  const threadSummary = buildThreadSummary();
  if (threadSummary) {
    if (isResume && lastSentThreadSummary === threadSummary) {
      prompt.add("threadDigestUnchanged", "thread digest unchanged", `[Thread digest unchanged — see previous turn]`, { kind: "reference" });
    } else {
      prompt.add("threadDigest", "thread digest", threadSummary, { kind: "history" });
      lastSentThreadSummary = threadSummary;
    }
  }

  if (userGuidance) {
    prompt.add("mission", "user mission", `USER MISSION: "${userGuidance}" — Manifest the user's implicit goals, extend them into actionable steps, and drive progress toward this mission.`, { kind: "guidance" });
  }
  if (activeProjects.length > 0) {
    prompt.add("activeProjects", "active project scope", `⚠️ ACTIVE PROJECTS: ${activeProjects.join(", ")}
The user has EXPLICITLY selected these projects. You MUST NOT investigate, file findings about, or suggest prompts for ANY other project. If ${APP_NAME} is working on a different project, observe but do not act on it. Findings about non-selected projects will be rejected by the server.`);
  } else {
    prompt.add("observeMode", "observe-all mode", `ℹ️ NO PROJECTS SELECTED — you are in OBSERVE-ALL mode. Investigate any project freely, file findings about anything interesting, but the server will NOT send messages to ${APP_NAME}. Your findings are stored for the user to review on the dashboard.`, { kind: "scope" });
  }
  // Dashboard tab context — tells brain what the user is focused on
  if (dashboardTab === "tracker") {
    prompt.add("dashboardTab", "dashboard tab", `Dashboard: user is viewing the TRACKER tab (findings/insights). Prioritize finding quality and actionability.`, { kind: "ui" });
  } else if (dashboardTab === "cli") {
    prompt.add("dashboardTab", "dashboard tab", `Dashboard: user is viewing the CLI tab.`, { kind: "ui" });
  }
  // chat tab is default, no need to mention it

  if (lastSentMessage && !looksLikeSyntheticControlText(lastSentMessage)) {
    if (lastSendFailed) {
      prompt.add("lastSend", "last send status", `⚠️ LAST SEND FAILED — your message "${lastSentMessage}" did NOT reach ${APP_NAME}. Check the screenshot to confirm. Do not build on a message that wasn't delivered.`, { kind: "delivery" });
    } else {
      const targetLabel = lastSentTarget || "unknown target";
      const receiptRefs = [lastSentFindingId, lastSentAttemptId ? `attempt:${shortSendAttemptId(lastSentAttemptId)}` : null].filter(Boolean).join(" · ");
      prompt.add("lastSend", "last send status", `Last message you sent to ${APP_NAME}: "${lastSentMessage}" via ${targetLabel}${receiptRefs ? ` (${receiptRefs})` : ""}. Only report it as delivered if live evidence matches that exact prompt. Do not infer delivery from general activity.`, { kind: "delivery" });
    }
  }
  if (sendsPending > 0 || sendsDelivered > 0 || sendsIgnored > 0) {
    prompt.add("sendStats", "send stats", `Send stats this session: ${sendsDelivered} delivered, ${sendsIgnored} ignored, ${sendsPending} pending verification.`, { kind: "delivery" });
  }
  const pendingReceiptSection = buildPendingReceiptSection();
  if (pendingReceiptSection) prompt.add("pendingReceipts", "pending receipts", pendingReceiptSection, { kind: "delivery" });

  const cliDeliveryContext = buildCliDeliveryContext();
  if (cliDeliveryContext) prompt.add("cliDelivery", "cli delivery context", cliDeliveryContext, { kind: "delivery" });

  // Include recent cycle topics so brain knows what it already investigated
  const recentTopics = cycleHistory
    .filter((c) => c.topic && c.topic.length > 10 && !looksLikeSyntheticControlText(c.topic))
    .slice(0, 10)
    .map((c, i) => `  ${c.cycle}. [${c.time}] ${c.topic}`)
    .join("\n");
  if (recentTopics) {
    prompt.add("recentTopics", "recent cycle topics", `Topics you already covered (don't repeat):\n${recentTopics}`, { kind: "history" });
  }

  // Files already investigated — helps brain explore new ground after context rotation
  if (filesInvestigated.length > 0) {
    prompt.add("filesInvestigated", "files investigated", `Files already investigated (${filesInvestigated.length} total, explore new ones): ${filesInvestigated.slice(-15).map(f => path.basename(f)).join(", ")}`, { kind: "history" });
  }

  // Goal hierarchy — Mission → Project → Goal → Insights
  loadGoals();
  const goalSection = buildGoalSection();
  if (goalSection) prompt.add("goals", "goal hierarchy", goalSection, { kind: "goals" });

  const openInsightSection = buildOpenInsightSection();
  if (openInsightSection) prompt.add("openInsights", "open insights", openInsightSection, { kind: "goals" });

  if (userMessage) {
    prompt.add("userMessage", "dashboard user message", `The dashboard user says: "${userMessage}"\n\nRespond to them. Use your tools if you need to look anything up, check files, run commands, etc. Then end with the JSON block.`, { kind: "instruction" });
  } else {
    prompt.add("cycleInstructions", "cycle instructions", `This is auto-cycle #${cycleCount}. No user message — YOUR time to think.

Read the screenshot first.

## CRITICAL: Empty/New Conversation Detection
If the screenshot shows an EMPTY or NEW ${APP_NAME} conversation (no messages, just the input field with a prompt placeholder), this is a "PICK UP WHERE LEFT OFF" moment. Do this:
1. Check the thread digest for the most recent session on the active project(s)
2. Check git log and git status for recent changes and uncommitted work
3. Compose a contextual resume prompt as your suggestedPrompt, like:
   "Continuing work on [project]. Last session you were [what they were doing from thread digest lastAssistantText/userMessages]. Recent commits: [last 2-3 commits]. [Uncommitted changes if any]. Pick up from here — [specific next step based on context]."
4. This is your HIGHEST PRIORITY action — send the resume prompt immediately. Don't investigate code or file other findings first.

## If the conversation is ACTIVE (has messages):
Pick ONE approach and go deep:

## Efficiency budget
- This loop runs continuously. Prefer one focused inspection over a broad repo tour.
- Start from the most likely file or command. Avoid workspace-wide searches when one active project is selected.
- Inspect at most 3 files and make at most 4 tool calls before you either file one strong insight or ask one strong question.
- Once you have one actionable insight tied to a goal, stop investigating and return the JSON. Do not keep browsing for backup findings in the same cycle.

1. **ASK CLAUDE DESKTOP A QUESTION** — It has the most context. Ask what it's working on, whether a fix worked, what's next. Use the "question" field in your JSON.
2. **THINK LIKE A USER** — Look at the active project. If you were using this app right now, what would feel incomplete? What page is missing details? What flow doesn't make sense? Trace the actual user experience.
3. **CONNECT TO A GOAL** — Check the Mission → Goals hierarchy above. What's the gap between where the project is and what the user wants? Link your insights to a goal via goalId. If you spot a new user goal, emit it in newGoals[].
4. **FIND A REAL UX GAP** — Not a code pattern issue. An actual "I clicked this and expected X but got Y" problem. Or a page that shows 3 fields when it should show 10.
5. **PROPOSE AN EXPERIENCE IMPROVEMENT** — Something that makes the app better for its user. Not cleaner code — better product.

USE YOUR TOOLS — read files, run the app's commands, check git. But focus on WHAT THE APP DOES, not just how the code looks.

End with the JSON block.`, { kind: "instruction" });
  }

  const built = prompt.build();
  const cycleEntry = createPromptProvenanceEntry({
    kind: "cycle",
    sessionType: "cycle",
    isResume,
    promptText: built.text,
    blocks: built.blocks,
    systemPrompt: CYCLE_SYSTEM_PROMPT,
    voiceProfileAttached: CYCLE_SYSTEM_PROMPT !== BASE_SYSTEM_PROMPT,
    importedHistoryAgents,
  });
  recordPromptProvenance("cycle", cycleEntry);
  broadcastState();

  return built.text;
}

// Call the brain via forked worker process (crash-isolated from server)
const BRAIN_WORKER_PATH = path.join(APP_DIR, "brain-worker.js");
const BRAIN_TIMEOUT_MS = 300000; // 5 minutes
const AUTO_CYCLE_REASONING_EFFORT = process.env.AUTOPILOT_CYCLE_REASONING_EFFORT || "medium";
const CHAT_REASONING_EFFORT = process.env.AUTOPILOT_CHAT_REASONING_EFFORT || "";
const TELEMETRY_SEARCH_COMMANDS = new Set(["rg", "grep", "git grep", "ag", "ack", "fd", "find"]);
const TELEMETRY_WAIT_COMMANDS = new Set(["sleep", "watch"]);
const TELEMETRY_SHELL_NOISE_COMMANDS = new Set(["cd", "export", "source", ".", "if", "then", "fi", "for", "do", "done", "while", "case", "esac"]);

let activeCycleWorker = null;

let cycleAborted = false;

function bumpTelemetryCount(map, key, amount = 1) {
  if (!map || !key) return;
  map[key] = (map[key] || 0) + amount;
}

function unwrapShellCommand(command) {
  let text = String(command || "").trim();
  let previous = null;
  while (text && text !== previous) {
    previous = text;
    const match = text.match(/^(?:\/usr\/bin\/env\s+)?(?:bash|zsh|sh|fish)\s+-lc\s+(['"])([\s\S]*)\1$/);
    if (!match) break;
    text = match[2].trim();
  }
  return text;
}

function extractTelemetryCommandLabels(command) {
  const text = unwrapShellCommand(command);
  if (!text) return [];
  const segments = text.split(/\s*(?:&&|\|\||;|\|)\s*/).map(segment => segment.trim()).filter(Boolean);
  const labels = [];

  for (const segment of segments) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g) || [];
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
    if (idx >= tokens.length) continue;

    let commandLabel = String(tokens[idx] || "").replace(/^['"`]|['"`]$/g, "");
    if (!commandLabel) continue;

    if (commandLabel === "env") {
      idx += 1;
      while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
      if (idx >= tokens.length) continue;
      commandLabel = String(tokens[idx] || "").replace(/^['"`]|['"`]$/g, "");
    }

    if (!commandLabel || TELEMETRY_SHELL_NOISE_COMMANDS.has(commandLabel)) continue;
    if (commandLabel === "git" && String(tokens[idx + 1] || "").replace(/^['"`]|['"`]$/g, "") === "grep") {
      labels.push("git grep");
      continue;
    }
    labels.push(commandLabel);
  }

  return labels;
}

function classifyTelemetryCommand(label) {
  if (!label) return "other";
  if (TELEMETRY_SEARCH_COMMANDS.has(label)) return "search";
  if (TELEMETRY_WAIT_COMMANDS.has(label)) return "wait";
  return "shell";
}

function createBrainTelemetryTracker(sessionType = "cycle") {
  return {
    sessionType,
    eventCounts: {},
    toolCounts: {},
    categoryCounts: {},
    toolUseCount: 0,
    thinkingTurns: 0,
    textChunks: 0,
    textChars: 0,
  };
}

function recordBrainTelemetryEvent(tracker, msg) {
  if (!tracker || !msg?.event) return;
  bumpTelemetryCount(tracker.eventCounts, msg.event);

  if (msg.event === "thinking_start") {
    tracker.thinkingTurns += 1;
    return;
  }

  if (msg.event === "text_delta") {
    tracker.textChunks += 1;
    tracker.textChars += String(msg.text || "").length;
    return;
  }

  if (msg.event !== "tool_use") return;

  tracker.toolUseCount += 1;
  const labels = extractTelemetryCommandLabels(msg.input);
  if (!labels.length) {
    const fallbackLabel = String(msg.name || "tool").trim().toLowerCase();
    if (fallbackLabel) {
      bumpTelemetryCount(tracker.toolCounts, fallbackLabel);
      bumpTelemetryCount(tracker.categoryCounts, classifyTelemetryCommand(fallbackLabel));
    }
    return;
  }

  for (const label of labels) {
    bumpTelemetryCount(tracker.toolCounts, label);
    bumpTelemetryCount(tracker.categoryCounts, classifyTelemetryCommand(label));
  }
}

function buildStaticCycleActivitySummary(mode, dominantEvents = [], phases = []) {
  return {
    mode: mode || "idle/waiting",
    toolCount: 0,
    commandCount: 0,
    searchCount: 0,
    dominantTools: [],
    dominantEvents: dominantEvents.length ? dominantEvents : ["waiting"],
    phases,
    textChunks: 0,
  };
}

function buildCycleBenchmark(meta = {}, extras = {}) {
  const usage = meta?.usage || extras.usage || null;
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const cachedTokens = (usage?.cache_read_input_tokens || 0)
    + (usage?.cache_creation_input_tokens || 0)
    + (usage?.cached_input_tokens || 0);
  const contextTokens = meta?.contextTokens || extras.contextTokens || 0;
  const durationMs = meta?.duration || extras.duration || 0;
  return {
    durationMs,
    contextTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    screenshotPromptMode: extras.screenshotPromptMode || lastCycleConversationSnapshotMode || "unprepared",
    screenshotPromptReason: extras.screenshotPromptReason || lastCycleConversationSnapshotReason || "",
    screenshotMode: extras.screenshotMode || lastScreenshotMode || "unknown",
  };
}

function finalizeBrainTelemetrySummary(tracker, meta = {}) {
  if (!tracker) return buildStaticCycleActivitySummary(meta.error ? "error" : "idle/waiting");

  const dominantTools = Object.entries(tracker.toolCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  const commandCount = dominantTools.length
    ? Object.values(tracker.toolCounts).reduce((sum, count) => sum + count, 0)
    : 0;
  const searchCount = tracker.categoryCounts.search || 0;
  const waitCount = tracker.categoryCounts.wait || 0;
  const phases = [];
  if (tracker.thinkingTurns > 0) phases.push("thinking");
  if (tracker.toolUseCount > 0) phases.push("tools");
  if (tracker.textChunks > 0) phases.push("reply");

  let mode = meta.mode || null;
  if (!mode) {
    if (meta.error) mode = "error";
    else if (commandCount === 0) mode = "idle/waiting";
    else if (waitCount >= Math.max(1, Math.ceil(commandCount / 2))) mode = "idle/waiting";
    else if (searchCount >= Math.max(2, Math.ceil(commandCount / 2))) mode = "search-heavy";
    else if (commandCount >= 4 || tracker.toolUseCount >= 3) mode = "shell-heavy";
    else mode = "light-touch";
  }

  const dominantEvents = dominantTools.map(({ name, count }) => `${name}×${count}`);
  if (!dominantEvents.length) {
    if (phases.length) dominantEvents.push(...phases);
    else dominantEvents.push("waiting");
  }

  return {
    mode,
    toolCount: tracker.toolUseCount,
    commandCount,
    searchCount,
    dominantTools,
    dominantEvents: dominantEvents.slice(0, 3),
    phases,
    textChunks: tracker.textChunks,
  };
}

function abortCycle(reason) {
  if (activeCycleWorker) {
    console.log(`[cycle] Aborting cycle brain: ${reason}`);
    cycleAborted = true;
    activeCycleWorker.kill("SIGKILL");
    activeCycleWorker = null;
  }
}

async function callBrain(prompt, sessionType = "cycle") {
  const startMs = Date.now();
  // Use the right session based on type
  const useSessionId = sessionType === "chat"
    ? chatSessionId
    : (STATELESS_AUTO_CYCLES ? null : cycleSessionId);
  const reasoningEffort = sessionType === "chat" ? CHAT_REASONING_EFFORT : AUTO_CYCLE_REASONING_EFFORT;

  return new Promise((resolve, reject) => {
    const isElectron = !!process.versions.electron;
    const execPath = (isElectron && fs.existsSync(SYSTEM_NODE)) ? SYSTEM_NODE : process.execPath;
    const brainCwd = getBrainWorkingDir(sessionType);

    const worker = fork(BRAIN_WORKER_PATH, [], {
      execPath,
      cwd: APP_DIR,
      silent: true,
      env: { ...process.env },
    });

    // Track cycle worker for preemption
    if (sessionType === "cycle") activeCycleWorker = worker;

    let finalText = "";
    let usage = null;
    let numTurns = 0;
    let resolved = false;
    const telemetry = createBrainTelemetryTracker(sessionType);

    const telemetryError = (error, extras = {}) => {
      const nextError = error instanceof Error ? error : new Error(String(error || "Brain worker failed"));
      nextError.activitySummary = finalizeBrainTelemetrySummary(telemetry, { ...extras, error: true });
      return nextError;
    };

    const parseFinalBrainResult = (text) => {
      const meta = {
        usage,
        duration: Date.now() - startMs,
        numTurns,
        contextTokens: brainContextTokens,
      };
      const result = parseBrainOutput(text, meta);
      result._meta = result._meta || meta;
      result._meta.activitySummary = finalizeBrainTelemetrySummary(telemetry, {
        duration: meta.duration,
        numTurns,
        usage,
        mode: result.status === "error" ? "error" : null,
      });
      return result;
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.kill("SIGKILL");
        reject(telemetryError(new Error("Brain worker timed out after 300s")));
      }
    }, BRAIN_TIMEOUT_MS);

    worker.on("message", (msg) => {
      if (msg.type === "event") {
        // Forward streaming events to dashboard
        broadcast({ type: "brainEvent", ...msg });
        recordBrainTelemetryEvent(telemetry, msg);
        if (msg.event === "text_delta") finalText = msg.accumulated || finalText;
      } else if (msg.type === "result") {
        usage = msg.usage;
        numTurns = msg.numTurns;
        const returnedId = msg.sessionId;
        // Track context window usage for session rotation
        const u = msg.usage || {};
        const tokens = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cached_input_tokens || 0) + (u.input_tokens || 0);
        // Update the correct session
        if (sessionType === "chat") {
          chatSessionId = returnedId || chatSessionId;
          chatContextTokens = tokens;
          if (chatContextTokens > CONTEXT_ROTATION_THRESHOLD) {
            chatSummary = buildChatSummary();
            try { fs.writeFileSync(CHAT_SUMMARY_FILE, chatSummary); } catch {}
            addChat("system", `Chat context at ${Math.round(chatContextTokens/1000)}K — rotating chat session (summary saved).`);
            chatSessionId = null;
            chatContextTokens = 0;
          }
        } else {
          cycleContextTokens = tokens;
          if (!STATELESS_AUTO_CYCLES) {
            cycleSessionId = returnedId || cycleSessionId;
          } else {
            cycleSessionId = null;
          }
          if (!STATELESS_AUTO_CYCLES && cycleContextTokens > CONTEXT_ROTATION_THRESHOLD) {
            addChat("system", `Cycle context at ${Math.round(cycleContextTokens/1000)}K — rotating cycle session.`);
            cycleSessionId = null;
            cycleContextTokens = 0;
            lastSentThreadSummary = null;
            lastSentProjectCtx = null;
          }
        }
        saveSessions();
        // Legacy aliases for backward compat
        brainSessionId = sessionType === "chat" ? chatSessionId : cycleSessionId;
        brainContextTokens = tokens;
        recordBrainTelemetryEvent(telemetry, {
          event: "result",
          usage,
          duration: Date.now() - startMs,
          numTurns,
        });
        broadcast({
          type: "brainEvent", event: "result",
          usage, duration: Date.now() - startMs, numTurns, contextTokens: tokens,
        });
      } else if (msg.type === "done") {
        finalText = msg.text || finalText;
        // Worker finished — parse and resolve
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try {
            resolve(parseFinalBrainResult(finalText));
          } catch (e) {
            reject(telemetryError(e));
          }
        }
      } else if (msg.type === "error") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(telemetryError(new Error(msg.message)));
        }
      }
    });

    worker.on("exit", (code) => {
      if (sessionType === "cycle") activeCycleWorker = null;
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        // Gracefully handle aborted cycles (SIGKILL from abortCycle)
        if (cycleAborted && sessionType === "cycle") {
          cycleAborted = false;
          resolve({ reply: "", findings: [], filesInvestigated: [], _meta: { aborted: true } });
          return;
        }
        cycleAborted = false;
        if (finalText.trim()) {
          try {
            resolve(parseFinalBrainResult(finalText));
          } catch (e) {
            reject(telemetryError(e));
          }
        } else {
          reject(telemetryError(new Error(`Brain worker exited with code ${code} and no output`)));
        }
      }
    });

    worker.stderr.on("data", (data) => {
      console.error("[brain-worker stderr]", data.toString().slice(0, 200));
    });

    // Send the query to the worker
    const systemPrompt = sessionType === "chat" ? CHAT_SYSTEM_PROMPT : CYCLE_SYSTEM_PROMPT;

    worker.send({
      type: "run",
      prompt,
      systemPrompt,
      sessionId: useSessionId,
      cwd: brainCwd,
      codexPath: CODEX_PATH,
      model: BRAIN_MODEL,
      reasoningEffort,
    });
  });
}

function parseBrainOutput(finalText, meta) {
  if (!finalText.trim()) {
    throw new Error("No output from brain");
  }

  function tryParseJson(str) {
    try {
      return JSON.parse(str);
    } catch {
      const fixed = str.replace(/(?<=:\s*")([\s\S]*?)(?="[\s]*[,}])/g, (match) => {
        return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      });
      try { return JSON.parse(fixed); } catch { return null; }
    }
  }

  const jsonBlocks = finalText.match(/```json\s*([\s\S]*?)```/g);
  if (jsonBlocks) {
    const lastBlock = jsonBlocks[jsonBlocks.length - 1];
    const inner = lastBlock.replace(/```json\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = tryParseJson(inner);
    if (parsed && parsed.reply) { parsed._meta = meta; return parsed; }
  }
  const jsonMatch = finalText.match(/\{[\s\S]*"reply"[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = tryParseJson(jsonMatch[0]);
    if (parsed && parsed.reply) { parsed._meta = meta; return parsed; }
  }
  const replyMatch = finalText.match(/"reply"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
  if (replyMatch) {
    return { reply: replyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'), send: null, status: "idle", _meta: meta };
  }
  throw new Error("Failed to parse brain output — no reply field found");
}

// Safety: reset state if stuck in CHECKING for too long
let thinkingTimer = null;
function startThinkingGuard() {
  clearThinkingGuard();
  thinkingTimer = setTimeout(() => {
    if (state === "CHECKING") {
      addChat("system", "Cycle timed out — resetting status.");
      broadcast({ type: "brainDone" });
      state = "IDLE";
      broadcastState();
    }
    if (chatBusy) {
      addChat("system", "Chat timed out — resetting.");
      broadcast({ type: "brainDone" });
      chatBusy = false;
      broadcastState();
      drainPendingChat();
    }
  }, 310000); // slightly longer than worker timeout (300s)
}
function clearThinkingGuard() {
  if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
}

// User chats with the brain — runs independently of auto-cycles
let pendingChatQueue = [];
let chatBusy = false;
async function chatWithBrain(userMessage) {
  // Intercept "goal: ..." messages to create goals directly
  const goalMatch = userMessage && userMessage.match(/^goal:\s*(.+)/i);
  if (goalMatch) {
    const goalText = goalMatch[1].trim();
    const slashIdx = goalText.indexOf("/");
    let project, title;
    if (slashIdx > 0 && slashIdx < 30) {
      project = goalText.slice(0, slashIdx).trim();
      title = goalText.slice(slashIdx + 1).trim();
    } else {
      project = activeProjects[0] || "default";
      title = goalText;
    }
    loadGoals();
    if (!goalsData.projects[project]) goalsData.projects[project] = { description: "", goals: [] };
    goalsData.projects[project].goals.push({
      id: `goal-${project}-${Date.now()}`,
      title,
      source: "user",
      priority: 1,
      status: "active",
      created: new Date().toISOString(),
      insights: [],
    });
    saveGoals();
    addChat("system", `Goal added to ${project}: "${title}"`);
    broadcastState();
    drainPendingChat();
    return;
  }
  // Preempt auto-cycle if running — user chat takes priority
  if (state === "CHECKING" && activeCycleWorker) {
    abortCycle("user chat takes priority");
    state = "IDLE";
    broadcast({ type: "brainDone" });
    addChat("system", "Auto-cycle preempted — handling your message first.");
    broadcastState();
  }
  if (chatBusy) {
    pendingChatQueue.push(userMessage);
    addChat("system", `Chat busy — queued (${pendingChatQueue.length} waiting).`);
    return;
  }
  chatBusy = true;
  broadcastState();
  addChat("user", userMessage);
  broadcast({ type: "brainStart" });

  // Take screenshot for context
  const buf = await takeScreenshot();
  if (buf) {
    fs.writeFileSync(SCREENSHOT_PATH, buf);
  }

  try {
    const prompt = buildChatPrompt(userMessage);
    const result = await callBrain(prompt, "chat");

    addChat("brain", result.reply, { meta: result._meta });
    broadcast({ type: "brainDone" });

    // Merge findings from user chat
    mergeFindings(result.findings, result.filesInvestigated);

    const persistedMemoryUpdates = applyMemoryUpdates(result.memoryUpdates, "chat");
    if (persistedMemoryUpdates > 0) {
      addChat("system", `Persisted ${persistedMemoryUpdates} memory update(s).`);
    }

    // Process status updates from brain (sent → implemented, etc.)
    if (result.statusUpdates && result.statusUpdates.length) {
      for (const update of result.statusUpdates) {
        if (!update.id || !update.status) continue;
        const f = findings.find(f => f.id === update.id);
        if (update.status === "received") {
          const applied = markFindingReceived(update.id, {
            attemptId: update.attemptId || null,
            source: update.receiptSource || "brain-status-update",
            evidence: update.receiptEvidence || `${RUNTIME_AGENT_LABEL} brain promoted the exact prompt to received from live evidence.`,
            target: update.target || null,
          });
          if (!applied) {
            console.log(`[statusUpdates] Ignored unverified received update for ${update.id}`);
            continue;
          }
          continue;
        }
        if (f && f.status !== update.status) {
          f.status = update.status;
          broadcastFindingUpdate(update.id, update.status, buildFindingStatusBroadcastExtra(f));
        }
      }
      saveFindings();
      broadcastState();
    }

    // Process new goals and goal updates from chat
    if (result.newGoals && result.newGoals.length) {
      for (const ng of result.newGoals) {
        if (!ng.title || !ng.project) continue;
        if (!goalsData.projects[ng.project]) goalsData.projects[ng.project] = { description: "", goals: [] };
        const existing = goalsData.projects[ng.project].goals;
        const isDup = existing.some(g => similarity(g.title, ng.title) > 0.5);
        if (!isDup && existing.length < 15) {
          existing.push({ id: `goal-${ng.project}-${Date.now()}`, title: ng.title, source: ng.source || "brain", priority: existing.length + 1, status: "active", created: new Date().toISOString(), insights: [] });
        }
      }
      saveGoals();
    }
    if (result.goalUpdates && result.goalUpdates.length) {
      for (const gu of result.goalUpdates) {
        if (!gu.id || !gu.status) continue;
        for (const project of Object.values(goalsData.projects)) {
          const goal = (project.goals || []).find(g => g.id === gu.id);
          if (goal) goal.status = gu.status;
        }
      }
      saveGoals();
    }

    if (result.suggestedPrompt) {
      broadcast({ type: "suggestedPrompt", prompt: result.suggestedPrompt, title: result.suggestedTitle || null, findingId: result.suggestedFindingId || null });
    }

    if (result.send) {
      await sendToApp(result.send);
    }

    chatBusy = false;
    lastChatTime = Date.now();
    broadcastState();
    drainPendingChat();
  } catch (e) {
    addChat("error", "Brain error: " + e.message + (e.stderr ? " | " + e.stderr.slice(0, 200) : ""));
    broadcast({ type: "brainDone" });
    chatBusy = false;
    lastChatTime = Date.now();
    broadcastState();
    drainPendingChat();
  }
}

function drainPendingChat() {
  if (pendingChatQueue.length > 0) {
    const msg = pendingChatQueue.shift();
    chatWithBrain(msg);
  }
}

// Auto-cycle — brain checks on the conversation
let continueQueue = 0;

async function runCycle() {
  if (!running) return;
  if (state === "CHECKING") {
    console.log("[cycle] Already running — skipping");
    scheduleNextCycle();
    return;
  }

  // Fast path: if continue is queued, send it directly without brain
  if (continueQueue > 0) {
    continueQueue--;
    broadcastState();
    console.log(`[cycle] Sending queued continue (${continueQueue} remaining)`);
    const sendResult = await sendToApp("continue");
    if (!sendResult.ok) {
      continueQueue++; // Re-queue on failure (cooldown, etc.)
      console.log("[cycle] Continue send failed — re-queued");
    }
    scheduleNextCycle();
    return;
  }

  cycleCount++;

  // No auto-expire: findings persist until user dismisses or parks them

  state = "CHECKING";
  broadcastState();
  startThinkingGuard();
  broadcast({ type: "brainStart" });

  const buf = await takeScreenshot();
  if (!buf) { clearThinkingGuard(); scheduleNextCycle(); return; }

  fs.writeFileSync(SCREENSHOT_PATH, buf);

  // Pre-flight: skip cycle if the desktop app is busy (saves 30-60s of compute)
  const idle = await isDesktopIdle(buf);
  const dedicatedCliAvailable = shouldPreferCliDelivery() && await ensureCliSessionReady({ requireIdle: false, autoStart: true, timeoutMs: 8000 });
  if (!idle && !dedicatedCliAvailable) {
    console.log(`[cycle] Skipped — ${APP_NAME} busy`);
    lastCycleConversationSnapshotMode = "waiting";
    lastCycleConversationSnapshotReason = `${APP_NAME} busy`;
    broadcast({ type: "brainDone" });
    clearThinkingGuard();
    cycleHistory.unshift({
      cycle: cycleCount,
      time: new Date().toLocaleTimeString(),
      status: "skipped",
      sent: false,
      duration: 0,
      numTurns: 0,
      contextTokens: 0,
      topic: `${APP_NAME} busy — skipped`,
      activity: buildStaticCycleActivitySummary("idle/waiting", [`${APP_NAME.toLowerCase()} busy`], ["waiting"]),
      benchmark: buildCycleBenchmark(null, {
        screenshotPromptMode: lastCycleConversationSnapshotMode,
        screenshotPromptReason: lastCycleConversationSnapshotReason,
        screenshotMode: lastScreenshotMode,
      }),
    });
    if (cycleHistory.length > 20) cycleHistory.pop();
    scheduleNextCycle();
    return;
  }
  if (!idle && dedicatedCliAvailable) {
    console.log(`[cycle] ${APP_NAME} desktop busy — continuing because dedicated CLI delivery is available`);
  }

  try {
    await prepareCycleConversationSnapshot(buf, {
      receiptOnlyBusyConversation: !idle && dedicatedCliAvailable,
    });
    const prompt = buildBrainPrompt(null);
    const result = await callBrain(prompt);

    // Aborted cycles (preempted by user chat) — skip all processing
    if (result._meta && result._meta.aborted) {
      broadcast({ type: "brainDone" });
      scheduleNextCycle();
      return;
    }

    // Suppress auto-cycle chat reply if user chatted recently (avoids echo/duplicate)
    if (Date.now() - lastChatTime > 60000) {
      addChat("brain", result.reply, { auto: true, meta: result._meta });
    }
    broadcast({ type: "brainDone" });

    // Track send outcome reported by brain
    if (result.lastSendResult) {
      const verifiedAttempt = resolveReceiptAttempt(result.lastSendFindingId, result.lastSendAttemptId);
      const verifiedFindingId = verifiedAttempt?.findingId || null;
      if (result.lastSendResult === "delivered") {
        const applied = verifiedFindingId
          ? markFindingReceived(verifiedFindingId, {
            attemptId: verifiedAttempt?.attemptId || null,
            source: "brain-confirmed",
            evidence: `${RUNTIME_AGENT_LABEL} brain confirmed the exact sent prompt from live context.`,
          })
          : false;
        if (applied) noteSendVerification("delivered");
        if (!verifiedFindingId) {
          console.log("[cycle] Brain reported delivered, but no matching exact send attempt was available");
        }
        console.log(`[cycle] Brain confirmed: last send delivered${verifiedFindingId ? ` (${verifiedFindingId})` : ""}`);
      } else if (result.lastSendResult === "ignored") {
        const reverted = verifiedFindingId
          ? revertSentFindingToQueue(verifiedFindingId, {
            attemptId: verifiedAttempt?.attemptId || null,
            source: "brain-confirmed-ignored",
            evidence: `${RUNTIME_AGENT_LABEL} brain confirmed the exact sent prompt was ignored or not picked up.`,
            incrementRetry: false,
          })
          : false;
        if (reverted) noteSendVerification("ignored");
        if (!verifiedFindingId) {
          console.log("[cycle] Brain reported ignored, but no matching exact send attempt was available");
        }
        console.log(`[cycle] Brain reports: last send ignored${verifiedFindingId ? ` (${verifiedFindingId})` : ""}`);
      }
    }

    // Merge findings and files from this cycle
    mergeFindings(result.findings, result.filesInvestigated);

    const persistedMemoryUpdates = applyMemoryUpdates(result.memoryUpdates, "cycle");
    if (persistedMemoryUpdates > 0) {
      addChat("system", `Persisted ${persistedMemoryUpdates} memory update(s).`);
    }

    // Process status updates from brain
    if (result.statusUpdates && result.statusUpdates.length) {
      for (const update of result.statusUpdates) {
        if (!update.id || !update.status) continue;
        const f = findings.find(f => f.id === update.id);
        if (update.status === "received") {
          const applied = markFindingReceived(update.id, {
            attemptId: update.attemptId || null,
            source: update.receiptSource || "brain-status-update",
            evidence: update.receiptEvidence || `${RUNTIME_AGENT_LABEL} brain promoted the exact prompt to received from live evidence.`,
            target: update.target || null,
          });
          if (!applied) {
            console.log(`[statusUpdates] Ignored unverified received update for ${update.id}`);
            continue;
          }
          continue;
        }
        if (f && f.status !== update.status) {
          f.status = update.status;
          broadcastFindingUpdate(update.id, update.status, buildFindingStatusBroadcastExtra(f));
        }
      }
      saveFindings();
      broadcastState();
    }

    // Process new goals from brain
    if (result.newGoals && result.newGoals.length) {
      for (const ng of result.newGoals) {
        if (!ng.title || !ng.project) continue;
        if (!goalsData.projects[ng.project]) {
          goalsData.projects[ng.project] = { description: "", goals: [] };
        }
        const existing = goalsData.projects[ng.project].goals;
        // Dedup by word overlap
        const isDup = existing.some(g => similarity(g.title, ng.title) > 0.5);
        if (!isDup && existing.length < 15) {
          existing.push({
            id: `goal-${ng.project}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: ng.title,
            source: ng.source || "brain",
            priority: existing.length + 1, // brain goals = lowest priority
            status: "active",
            created: new Date().toISOString(),
            insights: [],
          });
          console.log(`[goals] Brain created goal: "${ng.title}" for ${ng.project}`);
        }
      }
      saveGoals();
    }

    // Process goal status updates from brain
    if (result.goalUpdates && result.goalUpdates.length) {
      for (const gu of result.goalUpdates) {
        if (!gu.id || !gu.status) continue;
        for (const project of Object.values(goalsData.projects)) {
          const goal = (project.goals || []).find(g => g.id === gu.id);
          if (goal) {
            goal.status = gu.status;
            console.log(`[goals] Brain updated goal "${goal.title.slice(0, 40)}" → ${gu.status}`);
          }
        }
      }
      saveGoals();
    }

    // Store suggestedPrompt on the linked finding as both pendingPrompt and a message
    if (result.suggestedPrompt && result.suggestedFindingId) {
      const linked = findings.find(f => f.id === result.suggestedFindingId);
      if (linked && linked.status === "identified") {
        linked.pendingPrompt = result.suggestedPrompt;
        if (!linked.messages) linked.messages = [];
        if (!linked.messages.some(m => similarity(m.text, result.suggestedPrompt) > 0.6)) {
          linked.messages.push({ text: result.suggestedPrompt, status: "pending", addedAt: new Date().toISOString() });
        }
        saveFindings();
      }
    }

    // Handle question — questions go through the pipeline as a special finding
    if (result.question && !isDuplicate(result.question)) {
      const qId = `question-${Date.now()}`;
      const now = new Date().toISOString();
      const qFinding = {
        id: qId, type: "question", title: result.question.slice(0, 80),
        detail: result.question, project: activeProjects[0] || null,
        status: "identified", pendingPrompt: result.question,
        firstSeen: now, lastSeen: now,
        messages: [{ text: result.question, status: "pending", addedAt: now }],
      };
      findings.push(qFinding);
      saveFindings();
      // Don't addChat("finding") here — brain reply already covers the question
      broadcast({ type: "suggestedPrompt", prompt: result.question, title: "Question: " + result.question.slice(0, 50), findingId: qId });
    }

    // Broadcast suggested prompt to dashboard
    if (result.suggestedPrompt && !isDuplicate(result.suggestedPrompt) && !isSuggestionDuplicate(result.suggestedPrompt)) {
      broadcast({ type: "suggestedPrompt", prompt: result.suggestedPrompt, title: result.suggestedTitle || null, findingId: result.suggestedFindingId || null });
      suggestedHistory.unshift(result.suggestedPrompt);
      if (suggestedHistory.length > 20) suggestedHistory.pop();
    }

    let sent = false;
    if (result.status === "active") {
      console.log("[cycle] Conversation active — watching");
    }

    // FINDING PIPELINE: pick top-priority identified finding with a prompt, then send it
    // Prioritize findings about user-selected active projects, then CWD project
    const projectCtx2 = gatherProjectContext();
    const cwdProject = projectCtx2.cwd ? path.basename(projectCtx2.cwd) : null;
    const typePriority = { bug: 0, improvement: 1, feature: 2, debt: 3 };
    // A finding is sendable if it has pendingPrompt OR a pending message
    const hasPendingMessage = (f) => f.pendingPrompt || (f.messages && f.messages.some(isPendingFindingMessage));
    // No projects selected = observe all but don't send
    const sendCandidate = activeProjects.length === 0 ? null : findings
      .filter(f => f.status === "identified" && hasPendingMessage(f))
      .filter((f) => !isSyntheticBenchmarkFinding(f))
      .filter(f => activeProjects.some(p => f.project && f.project.includes(p)))
      .sort((a, b) => {
        // Active project first (user-selected or CWD)
        const isActive = (p) => {
          if (activeProjects.length > 0) return activeProjects.some(ap => p && p.includes(ap));
          return cwdProject && p && p.includes(cwdProject);
        };
        const aActive = isActive(a.project) ? 0 : 1;
        const bActive = isActive(b.project) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        // Scale: small tasks first (1=trivial, 5=epic)
        const aScale = a.scale || 3;
        const bScale = b.scale || 3;
        if (aScale !== bScale) return aScale - bScale;
        // Rating: good > unrated > bad
        const ratingOrder = { good: 0, undefined: 1, bad: 2 };
        const ra = ratingOrder[a.rating] ?? 1;
        const rb = ratingOrder[b.rating] ?? 1;
        if (ra !== rb) return ra - rb;
        // Then by type: bugs first
        return (typePriority[a.type] ?? 2) - (typePriority[b.type] ?? 2);
      })[0];

    if (sendCandidate) {
      // Resolve the prompt to send: pendingPrompt or first pending message
      const promptToSend = sendCandidate.pendingPrompt
        || (sendCandidate.messages && sendCandidate.messages.find(isPendingFindingMessage))?.text;

      if (promptToSend && !isDuplicate(promptToSend)) {
        const sendCtx = buildFindingSendContext(sendCandidate, promptToSend);

        if (muteMode) {
          broadcastFindingUpdate(sendCandidate.id, "queued");
        } else {
          // 25s insight review window — user can read, edit, or intercept
          broadcastFindingUpdate(sendCandidate.id, "preview", { prompt: promptToSend, countdown: 25 });
          addChat("system", `New insight — sending in 25s: "${promptToSend.slice(0, 80)}..." — use ▲▼ to reprioritize or ✕ to cancel`);

          // Wait 25 seconds, checking for cancellation each second
          let cancelled = false;
          for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 1000));
            broadcast({ type: "sendCountdown", findingId: sendCandidate.id, remaining: 24 - i });
            reloadFindingsFromDisk();
            const current = findings.find(f => f.id === sendCandidate.id);
            if (!current || current.status === "ignored" || current.status === "parked" || current.status === "identified") {
              cancelled = true;
              if (current && current.status === "identified") {
                addChat("system", `Send intercepted — "${promptToSend.slice(0, 60)}..." returned to queue`);
              } else {
                addChat("system", `Send cancelled: "${promptToSend.slice(0, 60)}..."`);
              }
              break;
            }
          }

          if (!cancelled) {
            // 10s keystroke delay — last chance to intercept before typing
            broadcastFindingUpdate(sendCandidate.id, "typing", { prompt: promptToSend, countdown: 10 });
            broadcast({ type: "keystrokeCountdown", findingId: sendCandidate.id, total: 10 });

            let keystrokeCancelled = false;
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 1000));
              broadcast({ type: "keystrokeCountdown", findingId: sendCandidate.id, remaining: 9 - i });
              reloadFindingsFromDisk();
              const current = findings.find(f => f.id === sendCandidate.id);
              if (!current || current.status === "ignored" || current.status === "parked" || current.status === "identified") {
                keystrokeCancelled = true;
                if (current && current.status === "identified") {
                  addChat("system", `Keystroke intercepted — "${promptToSend.slice(0, 60)}..." returned to queue`);
                } else {
                  addChat("system", `Send cancelled before keystroke: "${promptToSend.slice(0, 60)}..."`);
                }
                break;
              }
            }

            if (!keystrokeCancelled) {
              const freshBuf = await takeScreenshot();
              if (freshBuf) fs.writeFileSync(SCREENSHOT_PATH, freshBuf);
              const stillIdle = freshBuf ? await isDesktopIdle(freshBuf) : true;

              broadcastFindingUpdate(sendCandidate.id, "sending", { prompt: promptToSend });

              if (stillIdle) {
                const sendResult = await sendToApp(promptToSend, sendCtx);
                sent = !!sendResult.ok && sendResult.receipt !== "queued";
                if (sendResult.ok) {
                  applySendResultToFindingRecord(sendCandidate, promptToSend, sendResult);
                  saveFindings();
                  broadcastFindingUpdate(sendCandidate.id, sendCandidate.status, buildFindingStatusBroadcastExtra(sendCandidate));
                  broadcastState();
                }
              } else {
                broadcastFindingUpdate(sendCandidate.id, "held");
              }
            }
          }
        }
      }
    }

    // Record cycle history with topic summary for brain self-awareness
    const topicSummary = (result.suggestedPrompt || result.reply || "").slice(0, 100);
    cycleHistory.unshift({
      cycle: cycleCount,
      time: new Date().toLocaleTimeString(),
      status: result.status || "idle",
      sent,
      duration: result._meta?.duration || 0,
      numTurns: result._meta?.numTurns || 0,
      contextTokens: result._meta?.contextTokens || 0,
      topic: topicSummary,
      activity: result._meta?.activitySummary || buildStaticCycleActivitySummary("idle/waiting"),
      benchmark: buildCycleBenchmark(result._meta, {
        screenshotPromptMode: lastCycleConversationSnapshotMode,
        screenshotPromptReason: lastCycleConversationSnapshotReason,
        screenshotMode: lastScreenshotMode,
      }),
    });
    if (cycleHistory.length > 20) cycleHistory.pop();

    // Auto-re-send findings stuck at "sent" (not yet received) — max 1 retry
    const RESEND_AFTER_MS = 300000; // re-send after 5 minutes
    const MAX_RESENDS = 1;
    const sentFindings = findings.filter((f) => f.status === "sent" && f.sentPrompt && f.sentAt && !isSyntheticBenchmarkFinding(f));
    for (const f of sentFindings) {
      const resendCount = f.resendCount || 0;
      if (resendCount >= MAX_RESENDS) {
        f.status = "failed";
        broadcastFindingUpdate(f.id, "failed");
        saveFindings();
        break;
      }
      if (Date.now() - f.sentAt > RESEND_AFTER_MS) {
        broadcastFindingUpdate(f.id, "resending");
        const resent = await sendToApp(f.sentPrompt, buildFindingSendContext(f, f.sentPrompt));
        if (resent.ok) {
          applySendResultToFindingRecord(f, f.sentPrompt, resent);
          f.resendCount = resendCount + 1;
          saveFindings();
          broadcastState();
        }
        break; // only re-send one per cycle
      }
    }

    clearThinkingGuard();
    scheduleNextCycle();
    drainPendingChat();
  } catch (e) {
    // Record failed cycle
    cycleHistory.unshift({
      cycle: cycleCount,
      time: new Date().toLocaleTimeString(),
      status: "error",
      sent: false,
      duration: 0,
      numTurns: 0,
      contextTokens: 0,
      error: e.message.slice(0, 80),
      activity: e.activitySummary || buildStaticCycleActivitySummary("error", ["worker error"], ["error"]),
      benchmark: buildCycleBenchmark(e.meta || null, {
        screenshotPromptMode: lastCycleConversationSnapshotMode,
        screenshotPromptReason: lastCycleConversationSnapshotReason,
        screenshotMode: lastScreenshotMode,
      }),
    });
    if (cycleHistory.length > 20) cycleHistory.pop();

    addChat("error", "Auto-check failed: " + e.message);
    broadcast({ type: "brainDone" });
    clearThinkingGuard();
    scheduleNextCycle();
    drainPendingChat();
  }
}

function scheduleNextCycle() {
  if (running) {
    state = "WAITING";
    broadcastState();
    loopTimer = setTimeout(() => runCycle(), settings.interval * 1000);
  }
}

function start() {
  if (running) return;
  running = true;
  cycleCount = 0;
  state = "WAITING";
  broadcastState();
  addChat("system", "Autopilot Codex started — checking every " + settings.interval + "s. First scan in 3s.");
  loopTimer = setTimeout(() => runCycle(), 3000); // fast first cycle
}

function stop() {
  running = false;
  state = "IDLE";
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  addChat("system", "Autopilot Codex stopped.");
  broadcastState();
}

// HTTP server
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8"));
  } else if (req.url.startsWith("/api/screenshot")) {
    try {
      const buf = fs.readFileSync(SCREENSHOT_PATH);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buf.length, "Cache-Control": "no-cache" });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end("No screenshot available");
    }
  } else if (req.url === "/api/queue-continue" && req.method === "POST") {
    continueQueue++;
    addChat("system", `Continue queued (${continueQueue} in queue)`);
    broadcastState();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: continueQueue }));
  } else if (req.url === "/api/finding-status" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { id, status } = JSON.parse(body);
        if (!id || !status) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "id and status required" }));
          return;
        }
        reloadFindingsFromDisk();
        const f = findings.find(f => f.id === id);
        if (!f) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "finding not found", id }));
          return;
        }
        const oldStatus = f.status;
        f.status = status;
        saveFindings();
        broadcastState();
        broadcastFindingUpdate(id, status);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, oldStatus, newStatus: status }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url.startsWith("/api/goals") && req.method === "GET") {
    loadGoals();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(goalsData));
  } else if (req.url === "/api/goals" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { action, project, goalId, title, priority, status } = JSON.parse(body);
        loadGoals();
        if (action === "add" && project && title) {
          if (!goalsData.projects[project]) goalsData.projects[project] = { description: "", goals: [] };
          const goals = goalsData.projects[project].goals;
          goals.push({
            id: `goal-${project}-${Date.now()}`,
            title,
            source: "user",
            priority: priority || 1,
            status: "active",
            created: new Date().toISOString(),
            insights: [],
          });
          saveGoals();
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (action === "update" && goalId) {
          for (const p of Object.values(goalsData.projects)) {
            const goal = (p.goals || []).find(g => g.id === goalId);
            if (goal) {
              if (title) goal.title = title;
              if (priority) goal.priority = priority;
              if (status) goal.status = status;
            }
          }
          saveGoals();
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (action === "removeProject" && project) {
          delete goalsData.projects[project];
          saveGoals();
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (action === "setProjectPriority" && project && priority != null) {
          const proj = goalsData.projects[project];
          if (proj) {
            proj.priority = priority;
            saveGoals();
            broadcastState();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (action === "setMission" && title) {
          goalsData.mission = title;
          userGuidance = title; // keep in-memory sync
          saveGoals();
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (action === "remove" && goalId) {
          for (const p of Object.values(goalsData.projects)) {
            p.goals = (p.goals || []).filter(g => g.id !== goalId);
          }
          saveGoals();
          broadcastState();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Send full state on connect — must match broadcastState() fields
  ws.send(JSON.stringify(buildStatePayload()));
  ws.send(JSON.stringify({ type: "chatLog", messages: chatLog }));
  // Send initial CLI terminal content
  if (cliLastScreen) ws.send(JSON.stringify({ type: "cli_terminal", content: cliLastScreen }));

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.action === "start") start();
      else if (msg.action === "stop") stop();
      else if (msg.action === "chat") {
        // Filter echoed autopilot messages to prevent feedback loop
        if (msg.text && msg.text.startsWith("autopilot:")) {
          console.log("[chat] Filtered echo: " + msg.text.slice(0, 60));
          return;
        }
        chatWithBrain(msg.text);
      } else if (msg.action === "sendDirect") {
        addChat("user", "[direct] " + msg.text);
        sendToApp(msg.text);
      } else if (msg.action === "guide") {
        // Unified: mission input updates goals.json mission
        loadGoals();
        goalsData.mission = msg.text;
        saveGoals();
        userGuidance = msg.text; // keep in-memory sync for brain prompt
        broadcastState();
      } else if (msg.action === "hideProject") {
        // Top-bar chip "×" only deselects the project; tracker removal is the destructive path.
        activeProjects = activeProjects.filter(p => p !== msg.project);
        try { atomicWriteSync(ACTIVE_PROJECTS_FILE, JSON.stringify(activeProjects)); } catch {}
        broadcastState();
      } else if (msg.action === "setProjects") {
        activeProjects = msg.projects || [];
        try { atomicWriteSync(ACTIVE_PROJECTS_FILE, JSON.stringify(activeProjects)); } catch {}
        for (const p of activeProjects) {
          if (p && !allProjects.includes(p)) allProjects.push(p);
        }
        allProjects.sort((a, b) => a.localeCompare(b));
        // Auto-create goals entries for newly activated projects
        let goalsChanged = false;
        for (const p of activeProjects) {
          if (!goalsData.projects[p]) {
            goalsData.projects[p] = { description: "", goals: [] };
            goalsChanged = true;
          }
        }
        if (goalsChanged) saveGoals();
        // Clear stale pendingPrompts from findings outside the new project filter
        if (activeProjects.length > 0) {
          let cleared = 0;
          for (const f of findings) {
            if (f.pendingPrompt && f.project && !activeProjects.some(p => f.project.includes(p))) {
              delete f.pendingPrompt;
              cleared++;
            }
          }
          if (cleared > 0) {
            saveFindings();
            console.log(`[setProjects] Cleared ${cleared} stale pendingPrompt(s) from deselected projects`);
          }
        }
        broadcastState();
      } else if (msg.action === "settings") {
        Object.assign(settings, msg.settings);
        addChat("system", "Interval: " + settings.interval + "s");
        broadcastState();
      } else if (msg.action === "getKnowledge") {
        const knowledge = loadKnowledge();
        ws.send(JSON.stringify({ type: "knowledge", ...knowledge }));
      } else if (msg.action === "addGoal") {
        const knowledge = loadKnowledge();
        knowledge.goals.goals.push({
          goal: msg.goal,
          project: msg.project || "general",
          status: "active",
          created: new Date().toISOString(),
        });
        knowledge.goals.updated = new Date().toISOString();
        atomicWriteSync(GOALS_FILE, JSON.stringify(knowledge.goals, null, 2));
        broadcast({ type: "knowledge", ...loadKnowledge() });
      } else if (msg.action === "completeGoal") {
        const knowledge = loadKnowledge();
        if (knowledge.goals.goals[msg.index]) {
          knowledge.goals.goals[msg.index].status = "completed";
          knowledge.goals.goals[msg.index].completedAt = new Date().toISOString();
        }
        atomicWriteSync(GOALS_FILE, JSON.stringify(knowledge.goals, null, 2));
        broadcast({ type: "knowledge", ...loadKnowledge() });
      } else if (msg.action === "savePrompt") {
        const knowledge = loadKnowledge();
        knowledge.prompts.prompts.push({
          prompt: msg.prompt,
          outcome: msg.outcome || "effective",
          project: msg.project || "general",
          savedAt: new Date().toISOString(),
        });
        knowledge.prompts.updated = new Date().toISOString();
        atomicWriteSync(PROMPTS_FILE, JSON.stringify(knowledge.prompts, null, 2));
        broadcast({ type: "knowledge", ...loadKnowledge() });
      } else if (msg.action === "sendSuggested") {
        if (msg.prompt) {
          if (isDuplicate(msg.prompt)) {
            console.log("[send] Blocked duplicate suggested send");
          } else {
            reloadFindingsFromDisk();
            const finding = msg.findingId ? findings.find(f => f.id === msg.findingId) : null;
            const sendCtx = buildFindingSendContext(finding, msg.prompt);
            const sendResult = await sendToApp(msg.prompt, sendCtx);
            // Only mark finding as "sent" if the send actually succeeded
            if (sendResult.ok && msg.findingId) {
              reloadFindingsFromDisk();
              const f = findings.find(f => f.id === msg.findingId);
              if (f) {
                applySendResultToFindingRecord(f, msg.prompt, sendResult);
                saveFindings();
                broadcastFindingUpdate(f.id, f.status, buildFindingStatusBroadcastExtra(f));
                broadcastState();
              }
            }
          }
        }
      } else if (msg.action === "updateFinding") {
        if (msg.findingId && msg.status) {
          const f = findings.find(f => f.id === msg.findingId);
          if (f) {
            f.status = msg.status;
            // Store the prompt that was sent so we can re-send if not received
            if (msg.status === "sent" && msg.sentPrompt) {
              f.sentPrompt = msg.sentPrompt;
              f.sentAt = Date.now();
            }
            saveFindings();
            broadcastState();
          }
        }
      } else if (msg.action === "dismissFinding") {
        const f = findings.find(f => f.id === msg.findingId);
        if (f) {
          f.status = "ignored";
          f.dismissedAt = new Date().toISOString();
          saveFindings();
          broadcastState();
        }
      } else if (msg.action === "parkFinding") {
        const f = findings.find(f => f.id === msg.findingId);
        if (f) {
          f.status = "parked";
          f.parkedAt = new Date().toISOString();
          saveFindings();
          broadcastState();
        }
      } else if (msg.action === "dismissAllFindings") {
        const activeStatuses = ["identified", "sent", "received"];
        let count = 0;
        for (const f of findings) {
          if (activeStatuses.includes(f.status)) {
            f.status = "ignored";
            f.dismissedAt = new Date().toISOString();
            count++;
          }
        }
        if (count) { saveFindings(); addChat("system", `Dismissed ${count} active finding(s).`); }
        broadcastState();
      } else if (msg.action === "rateFinding") {
        if (msg.findingId && msg.rating) {
          const f = findings.find(f => f.id === msg.findingId);
          if (f) {
            // Toggle: clicking same rating again clears it
            f.rating = f.rating === msg.rating ? null : msg.rating;
            saveFindings();
            broadcastState();
          }
        }
      } else if (msg.action === "setScale") {
        if (msg.findingId && msg.scale >= 1 && msg.scale <= 5) {
          const f = findings.find(f => f.id === msg.findingId);
          if (f) {
            f.scale = msg.scale;
            saveFindings();
            broadcastState();
          }
        }
      } else if (msg.action === "toggleMute") {
        muteMode = !muteMode;
        try { atomicWriteSync(MUTE_FILE, JSON.stringify({ muted: muteMode })); } catch (e) { console.error("[mute] Failed to persist mute state:", e.message); }
        if (muteMode) {
          addChat("system", "Mute ON — findings will queue instead of sending.");
        } else {
          // Count queued findings and reset them to identified so pipeline can re-evaluate
          const queued = findings.filter(f => f.status === "queued");
          for (const f of queued) {
            f.status = "identified";
          }
          if (queued.length > 0) {
            saveFindings();
            // Reset cooldown so queued findings can send immediately
            lastSendTime = 0;
          }
          addChat("system", `Mute OFF — ${queued.length} queued finding(s) ready to send.`);
        }
        broadcastState();
      } else if (msg.action === "switchTab") {
        dashboardTab = msg.tab || "chat";
      } else if (msg.action === "scanThreads") {
        const digest = scanRecentThreads();
        ws.send(JSON.stringify({ type: "threadScan", digest }));
        addChat("system", `Thread scan: ${digest.stats.totalLogsFound} logs found, ${digest.stats.sessionsIndexed} sessions indexed, ${digest.stats.sessionsFiltered} filtered.`);
        broadcastState();
      } else if (msg.action === "regenerateVoice") {
        generateVoiceProfile();
      } else if (msg.action && msg.action.startsWith("cli_")) {
        cliHandleAction(msg);
      }
    } catch (e) {
      console.error("WebSocket message error:", e);
      addChat("error", "WS handler error: " + (e.message || String(e)));
    }
  });
});

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  if (loopTimer) clearTimeout(loopTimer);
  if (threadScanTimer) clearInterval(threadScanTimer);
  saveFindings();
  wss.close();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Kill stale process on port before starting
function startServer() {
  // Pre-emptively kill anything on our port
  try {
    execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { timeout: 3000 });
  } catch {}
  setTimeout(() => {
    server.listen(PORT, () => {
      console.log(`${PRODUCT_NAME} running at http://localhost:${PORT}`);
      console.log(`  ${CLI_NAME}: ${CODEX_PATH}`);
      console.log(`  Working dir: ${USER_CWD} (${USER_CWD_SOURCE})`);
      console.log(`  Sessions dir: ${SESSIONS_DIR}`);
      console.log(`  Archived sessions: ${ARCHIVED_SESSIONS_DIR}`);
      console.log(`  Memory dir: ${MEMORY_DIR || "(none found)"}`);
      // ── Preflight checks ──────────────────────────────────────
      addChat("system", "Running preflight checks...");
      broadcastState();
      const preflight = { auth: false, screenRecording: false, accessibility: false };
      let fatal = false;

      // 1. Codex auth
      addChat("system", `Checking ${APP_NAME} auth...`);
      broadcastState();
      if (!checkCodexAuth()) {
        console.error(`${APP_NAME} is not logged in. Run: codex login`);
        addChat("system", `✗ ${APP_NAME} — not logged in. Run \`codex login\` in a terminal, then restart.`);
        fatal = true;
      } else {
        addChat("system", `✓ ${APP_NAME} — authenticated.`);
        preflight.auth = true;
      }

      // 2. Screen Recording permission (screencapture)
      try {
        const testImg = path.join(require("os").tmpdir(), "autopilot-preflight-test.png");
        execSync(`screencapture -x -t png "${testImg}"`, { timeout: 5000 });
        if (fs.existsSync(testImg)) {
          const stat = fs.statSync(testImg);
          fs.unlinkSync(testImg);
          if (stat.size > 100) {
            addChat("system", "✓ Screen Recording — granted.");
            preflight.screenRecording = true;
          } else {
            addChat("system", "✗ Screen Recording — permission denied. Grant it to Terminal (or node) in System Settings → Privacy & Security → Screen Recording, then restart.");
          }
        }
      } catch {
        addChat("system", "✗ Screen Recording — permission denied. Grant it to Terminal (or node) in System Settings → Privacy & Security → Screen Recording, then restart.");
      }

      // 3. Accessibility permission (AppleScript keystroke typing)
      try {
        execSync(`osascript -e 'tell application "System Events" to return name of first process'`, { timeout: 5000 });
        addChat("system", "✓ Accessibility — granted.");
        preflight.accessibility = true;
      } catch {
        addChat("system", "✗ Accessibility — permission denied. Grant it to Terminal (or node) in System Settings → Privacy & Security → Accessibility, then restart.");
      }

      broadcastState();

      if (fatal) {
        addChat("system", "Preflight failed — fix the issues above and restart Autopilot Codex.");
        broadcastState();
        return;
      }

      if (!preflight.screenRecording || !preflight.accessibility) {
        addChat("system", "Some permissions missing — Autopilot Codex will start but with reduced functionality.");
      }

      // ── Normal startup ─────────────────────────────────────────
      addChat("system", "Scanning threads...");
      const digest = scanRecentThreads();
      addChat("system", `Scanned ${digest.stats.totalLogsFound} logs and indexed ${digest.stats.sessionsIndexed} sessions (${digest.stats.sessionsFiltered} filtered).`);

      const autoSelectedProject = autoSelectInitialProjectIfNeeded();
      if (autoSelectedProject) {
        addChat("system", `Auto-selected current repo on first launch: ${autoSelectedProject.name}. Autopilot is live for this project.`);
      }

      const finishStartup = () => {
        takeScreenshot().then(() => broadcastState()).catch(() => {});
        start();
      };

      // Load existing trusted voice profile or regenerate from current Codex history
      const loadedVoiceProfile = loadVoiceProfile({ provenance: "loaded" });
      if (!loadedVoiceProfile) {
        addChat("system", describeVoiceProfileRecovery(getVoiceProfileMeta()));
        broadcastState();
        generateVoiceProfile().then((meta) => {
          addChat("system", formatVoiceProfileStartupMessage(meta || getVoiceProfileMeta(), " Auto-starting..."));
          broadcastState();
          finishStartup();
        }).catch(() => {
          finishStartup();
        });
      } else {
        addChat("system", formatVoiceProfileStartupMessage(loadedVoiceProfile, " Auto-starting..."));
        broadcastState();
        finishStartup();
      }
    });
    server.on("error", (err) => {
      console.error("Server error:", err.message);
    });
  }, 1000);
}

startServer();
