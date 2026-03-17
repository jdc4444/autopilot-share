const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, execSync, execFile, execFileSync, fork } = require("child_process");
const { promisify } = require("util");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const sharp = require("sharp");

const execAsync = promisify(exec);

// Ensure PATH includes common binary locations
if (!process.env.PATH || !process.env.PATH.includes("/opt/homebrew/bin")) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;
}

const HOME = require("os").homedir();
const PORT = parseInt(process.env.PORT) || 3460;
const APP_DIR = __dirname; // wherever this repo lives
const SCREENSHOT_PATH = "/tmp/autopilot-share/screen.png";
const SEND_SCRIPT = path.join(APP_DIR, "send_to_claude.py");
const AUTOPILOT_DIR = path.join(APP_DIR, "knowledge");
const SYSTEM_PROMPT_FILE = "/tmp/autopilot-share/system-prompt.txt";
try { fs.mkdirSync("/tmp/autopilot-share", { recursive: true }); } catch {}
try { fs.mkdirSync(AUTOPILOT_DIR, { recursive: true }); } catch {}

// ── Auto-detect paths ──────────────────────────────────────────────────────
// Find Claude CLI
function findClaude() {
  for (const p of [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(HOME, ".local/bin/claude"),
    path.join(HOME, ".npm-global/bin/claude"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("which", ["claude"], { encoding: "utf8", timeout: 3000 }).trim(); } catch {}
  return "claude"; // fallback to PATH
}

// Find system Node (not Electron's)
function findSystemNode() {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync("which", ["node"], { encoding: "utf8", timeout: 3000 }).trim(); } catch {}
  return process.execPath;
}

const CLAUDE_PATH = findClaude();
const SYSTEM_NODE = findSystemNode();

// Auto-detect projects base and sessions directories
const PROJECTS_BASE = path.join(HOME, ".claude/projects");

// Find the most relevant project session directory for the user's CWD
// Claude Code stores sessions in ~/.claude/projects/-PATH-ENCODED/
function findSessionsDir(cwd) {
  if (!fs.existsSync(PROJECTS_BASE)) return null;
  const encoded = cwd.replace(/\//g, "-");
  const exact = path.join(PROJECTS_BASE, encoded);
  if (fs.existsSync(exact)) return exact;
  // Try to find the closest match
  try {
    const dirs = fs.readdirSync(PROJECTS_BASE)
      .filter(d => fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory())
      .sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      if (encoded.startsWith(d) || d.startsWith(encoded)) {
        return path.join(PROJECTS_BASE, d);
      }
    }
  } catch {}
  return null;
}

// Find memory directory — looks for MEMORY.md in any project session dir
function findMemoryDir() {
  if (!fs.existsSync(PROJECTS_BASE)) return null;
  try {
    const dirs = fs.readdirSync(PROJECTS_BASE)
      .filter(d => {
        try { return fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory(); } catch { return false; }
      });
    for (const d of dirs) {
      const memDir = path.join(PROJECTS_BASE, d, "memory");
      if (fs.existsSync(path.join(memDir, "MEMORY.md"))) return memDir;
    }
  } catch {}
  return null;
}

// Detect user's working directory — configurable via env or auto-detect
const USER_CWD = process.env.AUTOPILOT_CWD || process.cwd();
const MEMORY_DIR = findMemoryDir();

// Agent system prompt — defines who the brain is and what it can do
let SYSTEM_PROMPT = `You are Autopilot — a product-minded collaborator who thinks like a user, not a linter.

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
{"reply": "what you say to the dashboard user", "suggestedPrompt": "actionable prompt for Claude Desktop, linked to an insight", "suggestedTitle": "3-8 word summary", "suggestedFindingId": "the insight id this prompt addresses", "question": "optional — a question to ASK Claude Desktop instead of suggesting", "findings": [{"id": "unique-slug", "type": "bug|feature|improvement|debt|question", "title": "short title", "file": "path/to/file or null", "project": "project-name", "detail": "1-2 sentence explanation", "goalId": "id of the goal this insight serves", "messages": [{"text": "prompt for Claude Desktop", "priority": "high|normal|low"}]}], "goalUpdates": [{"id": "goal-id", "status": "active|completed|paused"}], "newGoals": [{"title": "user goal you identified from context", "project": "project-name", "source": "brain"}], "statusUpdates": [{"id": "finding-id", "status": "implemented|received|failed"}], "filesInvestigated": ["paths you read this cycle"], "status": "active or idle"}
\`\`\`
### Insight structure
- **Insights** (listed as "findings" in JSON for backward compat) are observations tied to user goals. They persist across cycles and build on each other.
- **goalId** — link every insight to a goal. Check the goals list in your context for the right ID.
- **Messages are actions** — specific prompts to send to Claude Desktop. Add them in the insight's "messages" array.
- **Fuzzy matching** — if you create an insight similar to an existing one, the system auto-merges.
- **newGoals** — if you identify a user goal not yet in the system, emit it. Brain-sourced goals get lowest priority.
- **goalUpdates** — mark goals completed when all their insights are resolved, or paused if work stopped.
- suggestedPrompt + suggestedFindingId is a shortcut — creates a message on the linked insight.
- question is freeform — asks Claude Desktop something and auto-creates a question-type insight.
- statusUpdates: promote insights when you have evidence (screenshot, git, code).
IMPORTANT: reply must be valid JSON. Use \\n for newlines, \\" for quotes.
- DO NOT echo the suggestedPrompt text in your reply.`;

fs.writeFileSync(SYSTEM_PROMPT_FILE, SYSTEM_PROMPT);

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
        if (body) memories.push(body);
      }
    }
    userContext = memories.join("\n\n");
    memoryFileCount = memories.length;
  } catch (e) {
    console.error("Failed to load memories:", e.message);
  }
}
loadMemories();

// Voice profile is loaded later after knowledge system is initialized
// (see loadVoiceProfile() and generateVoiceProfile() below)

// ============================================================
// KNOWLEDGE SYSTEM — thread scanner, autopilot memory, goals, prompts
// ============================================================

const AUTOPILOT_MEMORY_FILE = path.join(AUTOPILOT_DIR, "autopilot-memory.md");
const GOALS_FILE = path.join(AUTOPILOT_DIR, "goals.json");
const PROMPTS_FILE = path.join(AUTOPILOT_DIR, "good-prompts.json");
const THREAD_DIGEST_FILE = path.join(AUTOPILOT_DIR, "thread-digest.json");
const FINDINGS_FILE = path.join(AUTOPILOT_DIR, "findings.json");
const VOICE_PROFILE_FILE = path.join(AUTOPILOT_DIR, "voice-profile.md");

// Initialize files if missing
function initKnowledgeFiles() {
  if (!fs.existsSync(AUTOPILOT_MEMORY_FILE)) {
    fs.writeFileSync(AUTOPILOT_MEMORY_FILE, `# Autopilot Memory
## User Preferences

## Communication Style

## Common Shorthand

## Common Bugs & Fixes

## Processes & Workflows

## Key Patterns
`);
  }
  if (!fs.existsSync(GOALS_FILE)) {
    fs.writeFileSync(GOALS_FILE, JSON.stringify({ mission: "", projects: {}, unlinked_insights: [], updated: new Date().toISOString() }, null, 2));
  }
  if (!fs.existsSync(PROMPTS_FILE)) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ prompts: [], updated: new Date().toISOString() }, null, 2));
  }
  if (!fs.existsSync(THREAD_DIGEST_FILE)) {
    fs.writeFileSync(THREAD_DIGEST_FILE, JSON.stringify({ sessions: {}, lastScan: null }, null, 2));
  }
  if (!fs.existsSync(FINDINGS_FILE)) {
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify({ findings: [], filesInvestigated: [], updated: null }, null, 2));
  }
}
initKnowledgeFiles();

// Findings tracker — persisted across restarts
let findings = [];
let filesInvestigated = [];
try {
  const fd = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf8"));
  findings = fd.findings || [];
  filesInvestigated = fd.filesInvestigated || [];
} catch {}

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

function findGoalForInsight(insight) {
  const project = insight.project;
  if (!project || !goalsData.projects[project]) return null;
  const goals = goalsData.projects[project].goals || [];
  if (goals.length === 0) return null;
  if (insight.goalId) {
    const match = goals.find(g => g.id === insight.goalId);
    if (match) return match;
  }
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
    if (!goal.insights) goal.insights = [];
    if (!goal.insights.includes(insight.id)) {
      goal.insights.push(insight.id);
      saveGoals();
    }
    return goal;
  }
  if (!goalsData.unlinked_insights.includes(insight.id)) {
    goalsData.unlinked_insights.push(insight.id);
    saveGoals();
  }
  return null;
}

// Extract goals from thread digest user messages
function extractGoalsFromThreads() {
  loadGoals();
  const digest = loadKnowledge().threadDigest;
  const sessions = Object.values(digest.sessions || {})
    .filter(s => s.messageCount > 0 && s.userMessages && s.userMessages.length > 0)
    .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));

  for (const session of sessions) {
    const project = session.inferredProject;
    if (!project) continue;
    if (project.includes('.') || project.length < 3) continue;
    if (!goalsData.projects[project]) {
      goalsData.projects[project] = { description: "", goals: [] };
    }
    for (const msg of session.userMessages) {
      if (msg.length < 30) continue;
      if (/^(continue|yes|no|ok|thanks|sure|yeah|hey|hi|hello|stop|wait|go|run|push|commit|check|print|show|read|open|close|try|test|see|look|do|done|skip|nah|nope|lol|hmm|huh|what|why|how|where|when|this|in |i can|i like|i think|i feel|i know|i just|i don)/i.test(msg)) continue;
      if (/[!]{2,}/.test(msg)) continue;
      if (/^\s*(why|what|how|where|when|can|does|is|are|do|did)\b/i.test(msg) && !/\b(add|build|create|implement|make it)\b/i.test(msg)) continue;
      const hasGoalStructure = /\b(build|create|add|implement|fix|improve|update|redesign|refactor|integrate|migrate|set up|configure|enable|support)\b.{5,}/i.test(msg);
      if (!hasGoalStructure) continue;
      const contentWords = msg.split(/\s+/).filter(w => w.length > 3);
      if (contentWords.length < 4) continue;
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

function linkExistingFindings() {
  loadGoals();
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

function reloadFindingsFromDisk() {
  try {
    const fd = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf8"));
    findings = fd.findings || [];
    filesInvestigated = fd.filesInvestigated || [];
  } catch {}
}

function findFuzzyMatch(nf) {
  const nfText = `${nf.title} ${nf.detail || ""}`;
  for (const f of findings) {
    if (f.id === nf.id) return f;
    const fText = `${f.title} ${f.detail || ""}`;
    if (similarity(nfText, fText) > 0.5 && f.project === nf.project) return f;
  }
  return null;
}

function mergeFindings(newFindings, newFiles) {
  reloadFindingsFromDisk();
  const now = new Date().toISOString();
  if (newFiles && newFiles.length) {
    for (const f of newFiles) {
      if (!filesInvestigated.includes(f)) filesInvestigated.push(f);
    }
  }
  if (newFindings && newFindings.length) {
    for (const nf of newFindings) {
      if (!nf.id || !nf.title) continue;
      if (activeProjects.length > 0 && nf.project && !activeProjects.some(p => nf.project.includes(p))) {
        console.log(`[mergeFindings] Rejected finding "${nf.id}" — project "${nf.project}" not in active projects`);
        continue;
      }
      let existing = findings.find(f => f.id === nf.id) || findFuzzyMatch(nf);
      if (existing) {
        existing.title = nf.title;
        existing.detail = nf.detail || existing.detail;
        existing.file = nf.file || existing.file;
        existing.type = nf.type || existing.type;
        existing.project = nf.project || existing.project;
        existing.lastSeen = now;
        if (nf.parentId) existing.parentId = nf.parentId;
        const protectedStatuses = ["sent", "received", "implemented", "ignored", "failed"];
        if (nf.status && !protectedStatuses.includes(existing.status)) {
          existing.status = nf.status;
        }
        if (nf.messages && nf.messages.length) {
          if (!existing.messages) existing.messages = [];
          for (const msg of nf.messages) {
            const isDup = existing.messages.some(m => similarity(m.text, msg.text) > 0.6);
            if (!isDup) existing.messages.push({ ...msg, addedAt: now });
          }
        }
        if (nf.pendingPrompt && !existing.messages?.some(m => similarity(m.text, nf.pendingPrompt) > 0.6)) {
          if (!existing.messages) existing.messages = [];
          existing.messages.push({ text: nf.pendingPrompt, status: "pending", addedAt: now });
          existing.pendingPrompt = nf.pendingPrompt;
        }
        if (existing.id !== nf.id) {
          console.log(`[mergeFindings] Fuzzy-merged "${nf.id}" into "${existing.id}"`);
        }
        broadcastFindingUpdate(existing.id, existing.status);
      } else {
        const finding = {
          ...nf,
          status: "identified",
          firstSeen: now,
          lastSeen: now,
          messages: [],
        };
        if (nf.pendingPrompt) {
          finding.messages.push({ text: nf.pendingPrompt, status: "pending", addedAt: now });
        }
        if (nf.messages && nf.messages.length) {
          for (const msg of nf.messages) {
            finding.messages.push({ ...msg, addedAt: now });
          }
        }
        findings.push(finding);
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

function loadKnowledge() {
  const knowledge = {};
  try { knowledge.memory = fs.readFileSync(AUTOPILOT_MEMORY_FILE, "utf8"); } catch { knowledge.memory = ""; }
  try { knowledge.goals = JSON.parse(fs.readFileSync(GOALS_FILE, "utf8")); } catch { knowledge.goals = { mission: "", projects: {}, unlinked_insights: [] }; }
  try { knowledge.prompts = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8")); } catch { knowledge.prompts = { prompts: [] }; }
  try { knowledge.threadDigest = JSON.parse(fs.readFileSync(THREAD_DIGEST_FILE, "utf8")); } catch { knowledge.threadDigest = { sessions: {} }; }
  return knowledge;
}

// ---- Thread Scanner ----
// Scans recent JSONL session logs across ALL project directories
function scanRecentThreads() {
  try {
    let allFiles = [];
    try {
      const projectDirs = fs.readdirSync(PROJECTS_BASE)
        .filter(d => { try { return fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory(); } catch { return false; } });
      for (const dir of projectDirs) {
        const dirPath = path.join(PROJECTS_BASE, dir);
        try {
          const dirFiles = fs.readdirSync(dirPath)
            .filter(f => f.endsWith(".jsonl"))
            .map(f => ({ name: f, path: path.join(dirPath, f), mtime: fs.statSync(path.join(dirPath, f)).mtimeMs, projectDir: dir }));
          allFiles.push(...dirFiles);
        } catch {}
      }
    } catch {
      return { sessions: {}, lastScan: null };
    }
    const files = allFiles
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 15);

    const digest = loadKnowledge().threadDigest;
    let newData = false;

    for (const file of files) {
      const sessionId = file.name.replace(".jsonl", "");
      const existing = digest.sessions[sessionId];
      if (existing && existing.scannedAt >= file.mtime) continue;

      newData = true;
      const userMessages = [];
      const tools = new Set();
      let firstTimestamp = null;
      let lastTimestamp = null;
      let sessionCwd = null;
      let lastAssistantText = null;
      let lastEditedFile = null;
      const projectRefs = {};

      try {
        const fileSize = fs.statSync(file.path).size;
        let lines;
        if (fileSize > 10 * 1024 * 1024) {
          try {
            const tailResult = execFileSync("tail", ["-c", "2000000", file.path], { encoding: "utf8", timeout: 10000, maxBuffer: 3 * 1024 * 1024 });
            const tailLines = tailResult.split("\n").filter(Boolean);
            const headResult = execFileSync("head", ["-c", "500000", file.path], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
            const headLines = headResult.split("\n").filter(Boolean);
            const seen = new Set();
            lines = [];
            for (const l of [...headLines, ...tailLines]) {
              const key = l.slice(0, 80);
              if (!seen.has(key)) { seen.add(key); lines.push(l); }
            }
          } catch {
            const tailResult = execFileSync("tail", ["-500", file.path], { encoding: "utf8", timeout: 5000 });
            lines = tailResult.split("\n").filter(Boolean);
          }
        } else {
          const content = fs.readFileSync(file.path, "utf8");
          lines = content.split("\n").filter(Boolean);
        }

        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (!firstTimestamp && d.timestamp) firstTimestamp = d.timestamp;
            if (d.timestamp) lastTimestamp = d.timestamp;
            if (d.type === "queue-operation" && d.operation === "enqueue" && d.content) {
              const text = d.content.trim();
              if (text && !text.startsWith("<task-notification") && text.length > 2 && text.length < 500) {
                userMessages.push(text);
              }
            }
            if (d.type === "assistant") {
              const msg = d.message;
              if (msg && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === "tool_use") {
                    tools.add(block.name);
                    const input = block.input || {};
                    const paths = [input.file_path, input.path, input.command, input.pattern, input.glob].filter(Boolean);
                    for (const p of paths) {
                      // Generic project inference: look for common code directory patterns
                      for (const m of String(p).matchAll(/(?:\/Documents\/Code|\/projects|\/repos|\/src|\/home\/\w+)\/([^/\s"']+)/g)) {
                        if (m[1]) projectRefs[m[1]] = (projectRefs[m[1]] || 0) + 1;
                      }
                    }
                    if ((block.name === "Edit" || block.name === "Write") && input.file_path) {
                      lastEditedFile = input.file_path;
                    }
                  }
                  if (block.type === "text" && block.text) lastAssistantText = block.text;
                }
              }
            }
            if (d.cwd && !sessionCwd) sessionCwd = d.cwd;
          } catch {}
        }
      } catch (e) {
        console.error(`Failed to scan ${file.name}: ${e.message}`);
        continue;
      }

      const inferredProject = Object.entries(projectRefs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      digest.sessions[sessionId] = {
        scannedAt: Date.now(),
        firstTimestamp,
        lastTimestamp,
        messageCount: userMessages.length,
        userMessages: [...new Set(userMessages)].slice(0, 50),
        toolsUsed: [...tools],
        cwd: sessionCwd || null,
        projectDir: file.projectDir || null,
        inferredProject,
        lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, 300) : null,
        lastEditedFile: lastEditedFile || null,
      };
    }

    // Purge brain's own sessions
    for (const [sid, sdata] of Object.entries(digest.sessions)) {
      if (sdata.messageCount === 0 && (!sdata.userMessages || sdata.userMessages.length === 0)) {
        delete digest.sessions[sid];
        newData = true;
      }
    }

    // Prune old sessions (keep last 30)
    const sessionIds = Object.keys(digest.sessions);
    if (sessionIds.length > 30) {
      const sorted = sessionIds
        .map(id => ({ id, mtime: digest.sessions[id].scannedAt }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const entry of sorted.slice(30)) {
        delete digest.sessions[entry.id];
      }
    }

    if (newData) {
      digest.lastScan = new Date().toISOString();
      atomicWriteSync(THREAD_DIGEST_FILE, JSON.stringify(digest, null, 2));
    }

    return digest;
  } catch (e) {
    console.error("Thread scan error:", e.message);
    return { sessions: {}, lastScan: null };
  }
}

// ============================================================
// VOICE PROFILE GENERATION — 3-step: collect messages → analyze → write doc
// ============================================================

// Default voice profile used when insufficient message history exists.
// Generic enough for any power user of Claude Code. Gets replaced once
// enough messages accumulate for a real analysis.
const DEFAULT_VOICE_PROFILE = `## Voice & Style

- **Concise and action-oriented.** Most messages are direct instructions — short imperative sentences, not paragraphs. Users of CLI tools tend to be terse.
- **Lowercase casual.** Minimal punctuation, lowercase preferred. Fragments over full sentences. "fix the bug" not "Could you please fix the bug?"
- **Approval is brief then pivots.** "great." "cool." "nice." — immediately followed by the next instruction. Don't dwell on success.
- **Frustration is direct.** Escalates through repetition and bluntness: "that's not right" → "I said X not Y" → "this is still broken". Triggered by: things not working after being told they're fixed, unnecessary additions, polish masking broken fundamentals.

## Thinking & Problem-Solving

- **Iterative.** Gives a broad direction, looks at the result, fires off corrections. Thinks by seeing output, not by writing specs upfront.
- **Challenges claims.** Will question whether something actually works vs just looks right. "is this real or does it just look real?"
- **Anti-bloat.** Wants fewer features done well. Hates unnecessary additions, over-engineering, and verbose explanations.

## How They Work With Claude

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


// Step 1: Pull ~1000 user messages from ALL JSONL session logs
function collectUserMessages(targetCount = 1000) {
  const messages = [];
  if (!fs.existsSync(PROJECTS_BASE)) return messages;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_BASE)
      .filter(d => { try { return fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory(); } catch { return false; } });

    let allFiles = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_BASE, dir);
      try {
        const files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => ({ path: path.join(dirPath, f), mtime: fs.statSync(path.join(dirPath, f)).mtimeMs }));
        allFiles.push(...files);
      } catch {}
    }

    // Sort by recency, process newest first
    allFiles.sort((a, b) => b.mtime - a.mtime);

    for (const file of allFiles) {
      if (messages.length >= targetCount) break;
      try {
        const fileSize = fs.statSync(file.path).size;
        let content;
        if (fileSize > 10 * 1024 * 1024) {
          // Large file — sample head + tail
          try {
            content = execFileSync("head", ["-c", "2000000", file.path], { encoding: "utf8", timeout: 5000 });
            content += "\n" + execFileSync("tail", ["-c", "2000000", file.path], { encoding: "utf8", timeout: 5000 });
          } catch { continue; }
        } else {
          content = fs.readFileSync(file.path, "utf8");
        }

        for (const line of content.split("\n")) {
          if (messages.length >= targetCount) break;
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type === "queue-operation" && d.operation === "enqueue" && d.content) {
              const text = d.content.trim();
              // Filter out system messages, very short/long messages, and duplicates
              if (text && !text.startsWith("<task-notification") && !text.startsWith("<") &&
                  text.length > 5 && text.length < 2000) {
                messages.push(text);
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch (e) {
    console.error("collectUserMessages error:", e.message);
  }

  // Deduplicate
  return [...new Set(messages)].slice(0, targetCount);
}

// Step 2: Analyze messages using Agent SDK (same auth as brain — no API key needed)
async function analyzeVoicePatterns(messages) {
  const { query } = require("@anthropic-ai/claude-agent-sdk");

  // Sample strategically: take messages spread across the collection
  const sample = [];
  const step = Math.max(1, Math.floor(messages.length / 200));
  for (let i = 0; i < messages.length && sample.length < 200; i += step) {
    sample.push(messages[i]);
  }
  // Also add some random ones for variety
  const shuffled = [...messages].sort(() => Math.random() - 0.5);
  for (const m of shuffled) {
    if (sample.length >= 300) break;
    if (!sample.includes(m)) sample.push(m);
  }

  const messagesText = sample.map((m, i) => `${i + 1}. "${m}"`).join("\n");

  const prompt = `You are analyzing a user's messages to Claude to build a voice profile. Here are ${sample.length} messages from their Claude Code sessions (out of ${messages.length} total collected):

${messagesText}

Write a comprehensive voice & communication profile covering:

## Voice & Style
- Message length patterns, punctuation habits, capitalization
- Common shorthand, abbreviations, or slang
- How they give instructions vs ask questions
- Typical sentence structure

## Thinking & Problem-Solving
- How they approach problems (vision-first? detail-first? iterative?)
- How they handle errors or unexpected results
- What they challenge or verify

## Frustration & Satisfaction Signals
- How they express mild → strong frustration (with examples from the messages)
- How they express approval/satisfaction (with examples)
- What triggers frustration

## Work Patterns
- How they delegate work
- What they expect in terms of autonomy
- Common workflows visible in their messages

## Design & Quality Preferences
- Any aesthetic preferences mentioned
- Quality standards they enforce

## 10 Sample Messages In Their Voice
Pick 10 representative messages that capture their style well. Include a mix of instructions, corrections, approvals, and complex requests.

Be specific and data-driven — reference actual patterns from the messages. This profile will be used to match their communication style in future interactions.`;

  let resultText = "";
  // Strip CLAUDECODE env var so the Agent SDK subprocess doesn't think
  // it's inside a nested Claude Code session and refuse to start.
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  try {
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: "You are a communication analyst. Analyze the messages and produce a detailed voice profile. Output ONLY the profile markdown — no preamble, no explanation.",
      allowedTools: [],
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      cwd: APP_DIR,
    },
  })) {
    if (message.type === "result" && message.result) {
      resultText = message.result;
    }
  }
  } finally {
    if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
  }

  if (!resultText) throw new Error("Voice analysis returned empty result");
  return resultText;
}

// Step 3: Write voice profile document
function writeVoiceProfile(analysis, messageCount) {
  const content = `---
name: voice-profile
description: Auto-generated voice profile from ${messageCount} user messages — used to match communication style
type: auto-generated
generated: ${new Date().toISOString()}
---

${analysis}
`;
  atomicWriteSync(VOICE_PROFILE_FILE, content);
  console.log(`Voice profile written (${messageCount} messages analyzed)`);
}

// Load voice profile into system prompt if it exists
function loadVoiceProfile() {
  try {
    if (fs.existsSync(VOICE_PROFILE_FILE)) {
      const raw = fs.readFileSync(VOICE_PROFILE_FILE, "utf8");
      const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      if (body) {
        SYSTEM_PROMPT += `\n\n## USER VOICE PROFILE — match this communication style\n${body}`;
        fs.writeFileSync(SYSTEM_PROMPT_FILE, SYSTEM_PROMPT);
        console.log("Voice profile loaded into system prompt");
        return true;
      }
    }
  } catch {}
  return false;
}

// Full pipeline: collect → analyze → write → load
async function generateVoiceProfile() {
  try {
    addChat("system", "Generating voice profile — Step 1: collecting user messages...");
    broadcastState();
    const messages = collectUserMessages(1000);
    if (messages.length < 20) {
      addChat("system", `Only found ${messages.length} messages — writing default voice profile. Will regenerate once you have more history.`);
      broadcastState();
      writeVoiceProfile(DEFAULT_VOICE_PROFILE, 0);
      loadVoiceProfile();
      return true;
    }
    addChat("system", `Step 1 complete: collected ${messages.length} unique messages`);
    broadcastState();

    addChat("system", "Step 2: analyzing voice patterns with Claude...");
    broadcastState();
    const analysis = await analyzeVoicePatterns(messages);
    addChat("system", "Step 2 complete: voice analysis done");
    broadcastState();

    addChat("system", "Step 3: writing voice profile...");
    broadcastState();
    writeVoiceProfile(analysis, messages.length);
    loadVoiceProfile();
    addChat("system", `Voice profile generated from ${messages.length} messages and loaded`);
    broadcastState();
    return true;
  } catch (e) {
    console.error("Voice profile generation failed:", e.message);
    // Fall back to default profile on any failure (missing API key, network, etc.)
    addChat("system", `Voice analysis unavailable (${e.message.split("—")[0].trim()}). Using default profile.`);
    broadcastState();
    writeVoiceProfile(DEFAULT_VOICE_PROFILE, 0);
    loadVoiceProfile();
    return true;
  }
}

function buildThreadSummary() {
  const digest = loadKnowledge().threadDigest;
  const allSessions = Object.entries(digest.sessions)
    .filter(([, data]) => data.messageCount > 0)
    .sort((a, b) => (b[1].lastTimestamp || 0) - (a[1].lastTimestamp || 0));

  if (allSessions.length === 0) return "";

  const isActiveProject = (data) => {
    const project = data.inferredProject || (data.cwd ? path.basename(data.cwd) : null);
    if (!project) return false;
    if (activeProjects.length > 0) return activeProjects.some(p => project.includes(p));
    return false;
  };

  const activeSessions = allSessions.filter(([, data]) => isActiveProject(data)).slice(0, 5);
  const otherSessions = allSessions.filter(([, data]) => !isActiveProject(data)).slice(0, 3);

  let summary = "";

  if (activeSessions.length > 0) {
    summary += `## Active Project Threads (${activeProjects.join(", ")})\n`;
    for (const [id, data] of activeSessions) {
      const date = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleDateString() : "?";
      const project = data.inferredProject || path.basename(data.cwd || "");
      const msgs = [...new Set((data.userMessages || []).filter(m =>
        !m.startsWith("continue") && !m.startsWith("<") && m.length > 5
      ))].slice(0, 10);
      if (msgs.length === 0) continue;
      summary += `\n### Session ${id.slice(0, 8)} — ${project} (${date}, ${data.messageCount} msgs)\n`;
      if (data.lastAssistantText) {
        summary += `Last response: "${data.lastAssistantText.slice(0, 300)}"\n`;
      }
      summary += `Key messages:\n`;
      for (const m of msgs) {
        summary += `- "${m.slice(0, 150)}"\n`;
      }
    }
  }

  if (otherSessions.length > 0) {
    summary += `\n## Other Recent Threads\n`;
    for (const [id, data] of otherSessions) {
      const date = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleDateString() : "?";
      const project = data.inferredProject || path.basename(data.cwd || "unknown");
      const topMsg = (data.userMessages || []).find(m => m.length > 5 && !m.startsWith("continue") && !m.startsWith("<"));
      summary += `- ${project} (${date}, ${data.messageCount} msgs)${topMsg ? `: "${topMsg.slice(0, 80)}"` : ""}\n`;
    }
  }

  return summary;
}

// Thread scan loop — runs every 5 minutes
let threadScanTimer = null;
function startThreadScanLoop() {
  scanRecentThreads();
  threadScanTimer = setInterval(() => {
    scanRecentThreads();
    broadcast({ type: "knowledgeUpdate", lastScan: new Date().toISOString() });
  }, 5 * 60 * 1000);
}
startThreadScanLoop();

setTimeout(() => {
  extractGoalsFromThreads();
  linkExistingFindings();
  console.log(`[goals] Loaded ${Object.keys(goalsData.projects).length} projects, ${Object.values(goalsData.projects).reduce((s, p) => s + (p.goals?.length || 0), 0)} goals`);
}, 2000);

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
let muteMode = (() => { try { return JSON.parse(fs.readFileSync(MUTE_FILE, "utf8")).muted; } catch { return true; } })();
let lastSentMessage = "";
let lastSendFailed = false;
let sendsPending = 0;
let sendsDelivered = 0;
let sendsIgnored = 0;
let loopTimer = null;
const GUIDANCE_FILE = path.join(AUTOPILOT_DIR, "guidance.txt");
let userGuidance = "";
try { userGuidance = fs.readFileSync(GUIDANCE_FILE, "utf8").trim(); } catch {}
if (goalsData.mission) userGuidance = goalsData.mission;
const ACTIVE_PROJECTS_FILE = path.join(AUTOPILOT_DIR, "active-projects.json");
let activeProjects = [];
try { activeProjects = JSON.parse(fs.readFileSync(ACTIVE_PROJECTS_FILE, "utf8")); } catch {}

// Discover all git projects in the user's CWD
function discoverProjects() {
  try {
    return fs.readdirSync(USER_CWD)
      .filter(d => {
        try { return fs.statSync(path.join(USER_CWD, d, ".git")).isDirectory(); } catch { return false; }
      }).sort();
  } catch { return []; }
}
const allProjects = discoverProjects();
const startTime = Date.now();

let cycleHistory = [];

const SENT_HISTORY_FILE = path.join(AUTOPILOT_DIR, "sent-history.json");
let sentHistory = [];
try { sentHistory = JSON.parse(fs.readFileSync(SENT_HISTORY_FILE, "utf8")); } catch {}

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

// Brain session tracking
const SESSION_FILE = path.join(AUTOPILOT_DIR, "brain-sessions.json");
let chatSessionId = null;
let chatContextTokens = 0;
let cycleSessionId = null;
let cycleContextTokens = 0;
try {
  const sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  chatSessionId = sessions.chatSessionId || null;
  cycleSessionId = sessions.cycleSessionId || null;
} catch {}
function saveSessions() {
  try { atomicWriteSync(SESSION_FILE, JSON.stringify({ chatSessionId, cycleSessionId }, null, 2)); } catch {}
}
let brainSessionId = null;
let brainContextTokens = 0;
let lastSentThreadSummary = null;
let lastSentProjectCtx = null;
const CONTEXT_ROTATION_THRESHOLD = 190000;

const CHAT_LOG_FILE = path.join(AUTOPILOT_DIR, "chat-log.json");
const CHAT_SUMMARY_FILE = path.join(AUTOPILOT_DIR, "chat-summary.md");
let chatLog = [];
let chatSummary = "";
try {
  const saved = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf8"));
  if (Array.isArray(saved)) chatLog = saved.slice(-200);
} catch {}
try { chatSummary = fs.readFileSync(CHAT_SUMMARY_FILE, "utf8").trim(); } catch {}
function saveChatLog() {
  try { atomicWriteSync(CHAT_LOG_FILE, JSON.stringify(chatLog.slice(-200), null, 2)); } catch {}
}
function buildChatSummary() {
  const convos = chatLog.filter(m => m.role === "user" || m.role === "brain");
  if (convos.length === 0) return "";
  const lines = convos.slice(-30).map(m => {
    const who = m.role === "user" ? "User" : "Brain";
    return `- ${who}: ${m.text.slice(0, 200)}`;
  });
  return `## Previous Conversation Summary (carried from rotated session)\n${lines.join("\n")}`;
}

let settings = { interval: 180 };

// ─── CLI Pilot (tmux integration) ────────────────────────────────────────
const CLI_SESSION = process.env.CLI_SESSION || "claude-auto";
let cliQueue = [];
let cliHistory = [];
let cliStatus = "disconnected";
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

function cliCapturePane() {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", CLI_SESSION, "-p"], { encoding: "utf8", timeout: 5000 });
  } catch { return null; }
}

function cliIsIdle(screen) {
  if (!screen) return false;
  const lines = screen.split("\n").filter(l => l.trim());
  if (lines.some(l => l.includes("esc to interrupt"))) return false;
  return lines.some(l => l.startsWith("❯"));
}

function cliSendToTmux(msg) {
  try {
    execFileSync("tmux", ["send-keys", "-t", CLI_SESSION, "-l", msg], { timeout: 5000 });
    execFileSync("tmux", ["send-keys", "-t", CLI_SESSION, "Enter"], { timeout: 5000 });
    return true;
  } catch { return false; }
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
      if (cliSendToTmux(item2.text)) {
        cliHistory.push({ text: item2.text, time: new Date().toLocaleTimeString(), type: "manual" });
        if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
        cliStatus = "working";
      }
      break;
    }
    case "cli_toggle_auto":
      cliAutoMode = !cliAutoMode;
      break;
  }
  cliSaveState();
  broadcastState();
}

function cliVerifySend(item) {
  let checks = 0;
  const iv = setInterval(() => {
    checks++;
    const screen = cliCapturePane();
    if (!screen || !cliIsIdle(screen)) { clearInterval(iv); return; }
    if (checks >= 16) {
      clearInterval(iv);
      cliQueue.unshift(item);
      const idx = cliHistory.findLastIndex(h => h.text === item.text);
      if (idx !== -1) cliHistory.splice(idx, 1);
      cliStatus = "idle";
      broadcastState();
    }
  }, 500);
}

// CLI polling loop
setInterval(() => {
  const screen = cliCapturePane();
  if (!screen) {
    if (cliStatus !== "disconnected") {
      cliStatus = "disconnected";
      broadcastState();
    }
    return;
  }
  if (screen !== cliLastScreen) {
    cliLastScreen = screen;
    broadcast({ type: "cli_terminal", content: screen });
  }
  const idle = cliIsIdle(screen);
  if (idle && cliStatus !== "idle") {
    cliStatus = "idle";
    broadcastState();
    if (cliAutoMode && cliQueue.length > 0) {
      cliAutoSendPending = true;
      setTimeout(() => {
        cliAutoSendPending = false;
        if (cliStatus === "idle" && cliQueue.length > 0) {
          const next = cliQueue.shift();
          if (!cliSendToTmux(next.text)) { cliQueue.unshift(next); return; }
          cliHistory.push({ text: next.text, time: new Date().toLocaleTimeString(), type: "auto" });
          if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
          cliStatus = "working";
          cliSaveState();
          cliVerifySend(next);
          broadcastState();
        }
      }, 3000);
    }
  } else if (idle && cliStatus === "idle" && cliAutoMode && cliQueue.length > 0 && !cliAutoSendPending) {
    const next = cliQueue.shift();
    if (!cliSendToTmux(next.text)) { cliQueue.unshift(next); return; }
    cliHistory.push({ text: next.text, time: new Date().toLocaleTimeString(), type: "auto" });
    if (cliHistory.length > 100) cliHistory.splice(0, cliHistory.length - 100);
    cliStatus = "working";
    cliSaveState();
    cliVerifySend(next);
    broadcastState();
  } else if (!idle && (cliStatus === "idle" || cliStatus === "disconnected")) {
    cliStatus = "working";
    broadcastState();
  }
}, 2000);

function addChat(role, text, extra) {
  const entry = { role, text, time: new Date().toLocaleTimeString(), ts: Date.now(), ...extra };
  chatLog.push(entry);
  if (chatLog.length > 500) chatLog.shift();
  broadcast({ type: "chat", entry });
  if (role === "user" || role === "brain") saveChatLog();
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

function broadcastFindingUpdate(id, status, extra) {
  broadcast({ type: "findingUpdate", id, status, ...extra });
}

function broadcastState() {
  reloadFindingsFromDisk();
  broadcast({
    type: "state",
    running,
    state,
    cycleCount,
    interval: settings.interval,
    uptime: Date.now() - startTime,
    memoryFiles: memoryFileCount,
    brainModel: "claude-opus-4-6",
    guidance: userGuidance,
    activeProjects,
    allProjects,
    cycleHistory,
    findings,
    filesInvestigated,
    continueQueue,
    screenshotDisabled,
    screenshotMode: lastScreenshotMode || "unknown",
    chatBusy,
    muteMode,
    queuedFindings: findings.filter(f => f.status === "queued").length,
    goals: goalsData,
    cli: { queue: cliQueue, history: cliHistory, status: cliStatus, autoMode: cliAutoMode, session: CLI_SESSION },
  });
}

// Get Claude Desktop window ID
async function getClaudeWindowId() {
  try {
    const scriptFile = "/tmp/autopilot-share/winid.js";
    const jxa = `ObjC.import('CoreGraphics');
var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
var result = '';
for (var i = 0; i < list.length; i++) {
  if (list[i].kCGWindowOwnerName === 'Claude' && list[i].kCGWindowLayer === 0) {
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

let screenshotDisabled = false;
let screenshotFailCount = 0;
let lastScreenshotMode = "unknown";

async function takeScreenshot() {
  if (screenshotDisabled) return null;
  try {
    const wid = await getClaudeWindowId();
    lastScreenshotMode = wid ? "Claude window" : "full screen";
    const cmd = wid
      ? `screencapture -x -t png -l${wid} "${SCREENSHOT_PATH}"`
      : `screencapture -x -t png "${SCREENSHOT_PATH}"`;

    const isElectron = !!process.versions.electron;
    if (isElectron && fs.existsSync(SYSTEM_NODE)) {
      await execAsync(`${SYSTEM_NODE} -e "require('child_process').execSync('${cmd}', {timeout: 5000})"`, { timeout: 8000 });
    } else {
      await execAsync(cmd, { timeout: 5000 });
    }
    screenshotFailCount = 0;
    return fs.readFileSync(SCREENSHOT_PATH);
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

let lastScreenshotHash = null;
let consecutiveChanges = 0;

async function isDesktopIdle(screenshotBuf) {
  if (lastScreenshotMode === "full screen") return true;
  let hashBuf = screenshotBuf;
  try {
    const meta = await sharp(screenshotBuf).metadata();
    const cropHeight = Math.min(200, meta.height);
    const top = meta.height - cropHeight;
    hashBuf = await sharp(screenshotBuf)
      .extract({ left: 0, top, width: meta.width, height: cropHeight })
      .toBuffer();
  } catch {}
  const hash = crypto.createHash("md5").update(hashBuf).digest("hex");
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
  if (consecutiveChanges >= 2) {
    console.log(`Idle check: ${consecutiveChanges} consecutive changes — busy`);
    return false;
  }
  return true;
}

let lastSendTime = 0;
const SEND_COOLDOWN_MS = 60000;
let lastExactSendText = "";
let lastExactSendTime = 0;

async function sendToApp(message, findingCtx) {
  try {
    if (muteMode) {
      console.log("[sendToApp] Called while muted — skipping.");
      return false;
    }
    if (message === lastExactSendText && Date.now() - lastExactSendTime < 300000) {
      console.log("[send] Blocked exact duplicate");
      return false;
    }
    if (isDuplicate(message)) {
      console.log("[send] Blocked similar duplicate: " + message.slice(0, 60));
      return false;
    }
    const timeSinceLastSend = Date.now() - lastSendTime;
    if (timeSinceLastSend < SEND_COOLDOWN_MS) {
      console.log(`[send] Cooldown — ${Math.ceil((SEND_COOLDOWN_MS - timeSinceLastSend) / 1000)}s remaining`);
      return false;
    }

    const prefixed = "autopilot: " + message;
    await new Promise((resolve, reject) => {
      const isElectron = !!process.versions.electron;
      if (isElectron && fs.existsSync(SYSTEM_NODE)) {
        const tmpScript = "/tmp/autopilot-share/send-cmd.js";
        fs.writeFileSync(tmpScript, `require("child_process").execFileSync("python3", [${JSON.stringify(SEND_SCRIPT)}, ${JSON.stringify(prefixed)}], {timeout: 15000});`);
        execFile(SYSTEM_NODE, [tmpScript], { timeout: 20000 }, (err, stdout, stderr) => {
          if (stderr) console.log("[send] send_to_claude.py stderr: " + stderr.trim());
          if (err) reject(err); else resolve();
        });
      } else {
        execFile("python3", [SEND_SCRIPT, prefixed], { timeout: 15000 }, (err, stdout, stderr) => {
          if (stderr) console.log("[send] send_to_claude.py stderr: " + stderr.trim());
          if (err) reject(err); else resolve();
        });
      }
    });
    lastSentMessage = message;
    lastSendFailed = false;
    lastSendTime = Date.now();
    lastExactSendText = message;
    lastExactSendTime = Date.now();
    sendsPending++;
    sentHistory.unshift(message);
    if (sentHistory.length > 10) sentHistory.pop();
    try { atomicWriteSync(SENT_HISTORY_FILE, JSON.stringify(sentHistory, null, 2)); } catch {}
    if (findingCtx) {
      broadcastFindingUpdate(findingCtx.id, "sent");
    }

    setTimeout(async () => {
      try {
        const preSendHash = lastScreenshotHash;
        const buf = await takeScreenshot();
        if (buf) {
          fs.writeFileSync(SCREENSHOT_PATH, buf);
          const postHash = crypto.createHash("md5").update(buf).digest("hex");
          const delivered = preSendHash && postHash !== preSendHash;
          console.log(`[send] Post-send: UI ${delivered ? "changed" : "unchanged"}`);
          if (!delivered && findingCtx) {
            reloadFindingsFromDisk();
            const f = findings.find(f => f.id === findingCtx.id);
            if (f && f.status === "sent") {
              f.status = "identified";
              f.pendingPrompt = f.sentPrompt || message;
              f.retryCount = (f.retryCount || 0) + 1;
              if (f.retryCount > 3) {
                f.status = "failed";
                addChat("system", `Message failed after 3 retries: "${message.slice(0, 60)}..."`);
              } else {
                addChat("system", `Message may not have landed — will retry next cycle (attempt ${f.retryCount}/3)`);
              }
              saveFindings();
              broadcastState();
            }
          }
        }
      } catch (e) {
        console.log("[send] Post-send screenshot failed: " + e.message);
      }
    }, 5000);
    return true;
  } catch (e) {
    lastSendFailed = true;
    addChat("error", "Send failed: " + e.message + (e.stderr ? "\nstderr: " + e.stderr.trim() : ""));
    return false;
  }
}

// Gather live project context for the brain
let cachedProjectCtx = null;
let lastProjectCtxCycle = 0;
function gatherProjectContext() {
  if (cachedProjectCtx && cycleCount - lastProjectCtxCycle < 3) {
    return cachedProjectCtx;
  }
  const ctx = {};

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
        ctx.cwdResolved = true;
      }
    } catch {}
  }

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
    try {
      const tree = execFileSync("find", [".", "-maxdepth", "2", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/.next/*"], { cwd: ctx.cwd, timeout: 3000, encoding: "utf8" });
      ctx.fileTree = tree.split("\n").slice(0, 60).join("\n").trim();
    } catch {}
  }

  try {
    const errLog = execSync(`tail -20 /tmp/autopilot-share/*.log 2>/dev/null || true`, { timeout: 2000 }).toString().trim();
    if (errLog) ctx.recentErrors = errLog.slice(0, 400);
  } catch {}

  cachedProjectCtx = ctx;
  lastProjectCtxCycle = cycleCount;
  return ctx;
}

function buildChatPrompt(userMessage) {
  const parts = [];
  const isResume = !!chatSessionId;

  if (!isResume) {
    parts.push(`Screenshot of Claude Desktop is at ${SCREENSHOT_PATH} — read it to see the current state.`);
    try {
      const mem = fs.readFileSync(AUTOPILOT_MEMORY_FILE, "utf8").trim();
      if (mem) parts.push(`## YOUR MEMORY\n${mem}`);
    } catch {}
    const projectCtx = gatherProjectContext();
    if (projectCtx.cwd) parts.push(`Working directory: ${projectCtx.cwd}`);
    if (projectCtx.gitLog) parts.push(`Recent commits:\n${projectCtx.gitLog}`);
    if (userGuidance) parts.push(`USER MISSION: "${userGuidance}"`);
    if (chatSummary) parts.push(chatSummary);
  }

  const recentChat = chatLog
    .filter(m => m.role === "user" || m.role === "brain")
    .slice(-20)
    .map(m => `[${m.role === "user" ? "USER" : "BRAIN"} ${m.time}] ${m.text.slice(0, 500)}`)
    .join("\n");

  if (recentChat && isResume) {
    parts.push(`Recent conversation (for reference):\n${recentChat}`);
  } else if (recentChat) {
    parts.push(`## Conversation History\n${recentChat}`);
  }

  parts.push(`USER: ${userMessage}\n\nRespond naturally. Use tools if needed. End with the JSON block.`);

  return parts.join("\n\n");
}

function buildGoalSection() {
  if (!goalsData.mission && Object.keys(goalsData.projects).length === 0) return "";

  let section = `## Mission → Goals → Insights\n`;
  if (goalsData.mission) {
    section += `**Mission:** ${goalsData.mission}\n\n`;
  }

  for (const [projectName, project] of Object.entries(goalsData.projects)) {
    const goals = (project.goals || []).filter(g => g.status === "active");
    if (goals.length === 0) continue;
    if (activeProjects.length > 0 && !activeProjects.some(p => projectName.includes(p))) continue;
    section += `### ${projectName}${project.description ? ` — ${project.description}` : ""}\n`;
    for (const goal of goals.sort((a, b) => (a.priority || 99) - (b.priority || 99))) {
      const insightIds = goal.insights || [];
      const linkedInsights = findings.filter(f => insightIds.includes(f.id) && f.status !== "ignored");
      const implemented = linkedInsights.filter(f => f.status === "implemented").length;
      const active = linkedInsights.filter(f => ["identified", "sent", "received"].includes(f.status)).length;
      section += `\n**Goal:** ${goal.title} (${goal.id})\n`;
      section += `  Source: ${goal.source} | Priority: ${goal.priority} | Insights: ${implemented} done, ${active} active\n`;
      if (linkedInsights.length > 0) {
        for (const insight of linkedInsights.slice(0, 8)) {
          section += `  - [${insight.status}] ${insight.title} (${insight.id})\n`;
        }
        if (linkedInsights.length > 8) {
          section += `  - ... and ${linkedInsights.length - 8} more\n`;
        }
      }
    }
    section += "\n";
  }

  const unlinked = goalsData.unlinked_insights || [];
  const unlinkedActive = findings.filter(f => unlinked.includes(f.id) && f.status !== "ignored");
  if (unlinkedActive.length > 0) {
    section += `**Unlinked insights (${unlinkedActive.length}):** These need a goal.\n`;
    for (const insight of unlinkedActive.slice(0, 5)) {
      section += `  - [${insight.status}] ${insight.title} (${insight.id})\n`;
    }
  }

  return section;
}

function buildBrainPrompt(userMessage) {
  const parts = [];
  parts.push(`Screenshot of Claude Desktop is at ${SCREENSHOT_PATH} — read it to see the current state.`);
  const isResume = !!cycleSessionId;

  if (userContext && (!isResume || cycleCount <= 1 || userMessage || cycleCount % 5 === 0)) {
    parts.push(`User context from memory files:\n${userContext}`);
  } else if (userContext && isResume) {
    parts.push(`[User context unchanged — see previous turn]`);
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
      parts.push(`[Project context unchanged — see previous turn]`);
    } else {
      parts.push(projectStr);
      lastSentProjectCtx = projectStr;
    }
  }

  if (!isResume || cycleCount % 5 === 0) {
    try {
      const mem = fs.readFileSync(AUTOPILOT_MEMORY_FILE, "utf8").trim();
      if (mem) {
        parts.push(`## YOUR MEMORY (autopilot-memory.md) — READ THIS CAREFULLY\n${mem}`);
      }
    } catch {}
  }

  if (sentHistory.length > 0) {
    parts.push(`Messages already sent to Claude Desktop (avoid repeating):\n${sentHistory.slice(0, 5).map((m, i) => `${i + 1}. "${m.slice(0, 120)}"`).join("\n")}`);
  }

  const threadSummary = buildThreadSummary();
  if (threadSummary) {
    if (isResume && lastSentThreadSummary === threadSummary) {
      parts.push(`[Thread digest unchanged — see previous turn]`);
    } else {
      parts.push(threadSummary);
      lastSentThreadSummary = threadSummary;
    }
  }

  if (userGuidance) parts.push(`USER MISSION: "${userGuidance}"`);
  if (activeProjects.length > 0) {
    parts.push(`ACTIVE PROJECTS: ${activeProjects.join(", ")}\nOnly investigate and file findings for these projects.`);
  } else {
    parts.push(`NO PROJECTS SELECTED — observe-all mode. Investigate freely but the server will NOT send messages.`);
  }
  if (lastSentMessage) {
    if (lastSendFailed) {
      parts.push(`LAST SEND FAILED — "${lastSentMessage}" did NOT reach Claude Desktop.`);
    } else {
      parts.push(`Last message sent to Claude Desktop: "${lastSentMessage}"`);
    }
  }
  if (sendsPending > 0 || sendsDelivered > 0 || sendsIgnored > 0) {
    parts.push(`Send stats: ${sendsDelivered} delivered, ${sendsIgnored} ignored, ${sendsPending} pending.`);
  }

  const recentTopics = cycleHistory
    .filter(c => c.topic && c.topic.length > 10)
    .slice(0, 10)
    .map((c, i) => `  ${c.cycle}. [${c.time}] ${c.topic}`)
    .join("\n");
  if (recentTopics) {
    parts.push(`Topics already covered (don't repeat):\n${recentTopics}`);
  }

  if (filesInvestigated.length > 0) {
    parts.push(`Files already investigated (${filesInvestigated.length} total): ${filesInvestigated.slice(-15).map(f => path.basename(f)).join(", ")}`);
  }

  loadGoals();
  const goalSection = buildGoalSection();
  if (goalSection) parts.push(goalSection);

  const activeFindings = findings.filter(f => f.status !== "ignored");
  if (activeFindings.length) {
    const findingLines = activeFindings.map(f => {
      let line = `  [${f.status}] ${f.title} (${f.id})`;
      if (f.goalId) line += ` → goal:${f.goalId}`;
      if (f.rating) line += ` ${f.rating === 'good' ? '+1' : '-1'}`;
      if (f.status === "sent" && f.sentPrompt) line += ` — awaiting receipt`;
      return line;
    }).join("\n");
    parts.push(`## Insight Tracker\n${findingLines}\n\n### Lifecycle:\nidentified → sent → received → implemented/failed/ignored\nYOU promote "received" → "implemented" or "failed" via statusUpdates[].`);
  }

  if (userMessage) {
    parts.push(`The dashboard user says: "${userMessage}"\n\nRespond to them. End with the JSON block.`);
  } else {
    parts.push(`Auto-cycle #${cycleCount}. Read the screenshot first.\n\nIf empty conversation: compose a contextual resume prompt.\nIf active: pick ONE approach — ask a question, find a UX gap, or connect to a goal.\n\nEnd with the JSON block.`);
  }

  return parts.join("\n\n");
}

// Call the brain via forked worker process
const BRAIN_WORKER_PATH = path.join(APP_DIR, "brain-worker.js");
const BRAIN_TIMEOUT_MS = 300000;

let activeCycleWorker = null;

function abortCycle(reason) {
  if (activeCycleWorker) {
    console.log(`[cycle] Aborting cycle brain: ${reason}`);
    activeCycleWorker.kill("SIGKILL");
    activeCycleWorker = null;
  }
}

async function callBrain(prompt, sessionType = "cycle") {
  const startMs = Date.now();
  const useSessionId = sessionType === "chat" ? chatSessionId : cycleSessionId;

  return new Promise((resolve, reject) => {
    const isElectron = !!process.versions.electron;
    const execPath = (isElectron && fs.existsSync(SYSTEM_NODE)) ? SYSTEM_NODE : process.execPath;

    // Strip CLAUDECODE env var so the Agent SDK subprocess doesn't think
    // it's inside a nested Claude Code session and refuse to start.
    const workerEnv = { ...process.env };
    delete workerEnv.CLAUDECODE;

    const worker = fork(BRAIN_WORKER_PATH, [], {
      execPath,
      cwd: APP_DIR,
      silent: true,
      env: workerEnv,
    });

    if (sessionType === "cycle") activeCycleWorker = worker;

    let finalText = "";
    let usage = null;
    let numTurns = 0;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.kill("SIGKILL");
        reject(new Error("Brain worker timed out after 300s"));
      }
    }, BRAIN_TIMEOUT_MS);

    worker.on("message", (msg) => {
      if (msg.type === "event") {
        broadcast({ type: "brainEvent", ...msg });
        if (msg.event === "text_delta") finalText = msg.accumulated || finalText;
      } else if (msg.type === "result") {
        usage = msg.usage;
        numTurns = msg.numTurns;
        const returnedId = msg.sessionId;
        const u = msg.usage || {};
        const tokens = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
        if (sessionType === "chat") {
          chatSessionId = returnedId || chatSessionId;
          chatContextTokens = tokens;
          if (chatContextTokens > CONTEXT_ROTATION_THRESHOLD) {
            chatSummary = buildChatSummary();
            try { fs.writeFileSync(CHAT_SUMMARY_FILE, chatSummary); } catch {}
            addChat("system", `Chat context at ${Math.round(chatContextTokens/1000)}K — rotating.`);
            chatSessionId = null;
            chatContextTokens = 0;
          }
        } else {
          cycleSessionId = returnedId || cycleSessionId;
          cycleContextTokens = tokens;
          if (cycleContextTokens > CONTEXT_ROTATION_THRESHOLD) {
            addChat("system", `Cycle context at ${Math.round(cycleContextTokens/1000)}K — rotating.`);
            cycleSessionId = null;
            cycleContextTokens = 0;
            lastSentThreadSummary = null;
            lastSentProjectCtx = null;
          }
        }
        saveSessions();
        brainSessionId = sessionType === "chat" ? chatSessionId : cycleSessionId;
        brainContextTokens = tokens;
        broadcast({
          type: "brainEvent", event: "result",
          usage, duration: Date.now() - startMs, numTurns, contextTokens: tokens,
        });
      } else if (msg.type === "done") {
        finalText = msg.text || finalText;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          try {
            const result = parseBrainOutput(finalText, { usage, duration: Date.now() - startMs, numTurns, contextTokens: brainContextTokens });
            resolve(result);
          } catch (e) {
            reject(e);
          }
        }
      } else if (msg.type === "error") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(msg.message));
        }
      }
    });

    worker.on("exit", (code) => {
      if (sessionType === "cycle") activeCycleWorker = null;
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (finalText.trim()) {
          try {
            const result = parseBrainOutput(finalText, { usage, duration: Date.now() - startMs, numTurns, contextTokens: brainContextTokens });
            resolve(result);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Brain worker exited with code ${code} and no output`));
        }
      }
    });

    worker.stderr.on("data", (data) => {
      console.error("[brain-worker stderr]", data.toString().slice(0, 200));
    });

    worker.send({
      type: "run",
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      sessionId: useSessionId,
      cwd: USER_CWD,
      claudePath: CLAUDE_PATH,
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

let thinkingTimer = null;
function startThinkingGuard() {
  clearThinkingGuard();
  thinkingTimer = setTimeout(() => {
    if (state === "CHECKING") {
      addChat("system", "Cycle timed out — resetting.");
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
  }, 310000);
}
function clearThinkingGuard() {
  if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
}

let pendingChatQueue = [];
let chatBusy = false;

async function chatWithBrain(userMessage) {
  const goalMatch = userMessage && userMessage.match(/^goal:\s*(.+)/i);
  if (goalMatch) {
    const goalText = goalMatch[1].trim();
    const slashIdx = goalText.indexOf("/");
    let project, title;
    if (slashIdx > 0 && slashIdx < 30) {
      project = goalText.slice(0, slashIdx).trim();
      title = goalText.slice(slashIdx + 1).trim();
    } else {
      project = activeProjects[0] || "general";
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

  const buf = await takeScreenshot();
  if (buf) fs.writeFileSync(SCREENSHOT_PATH, buf);

  try {
    const prompt = buildChatPrompt(userMessage);
    const result = await callBrain(prompt, "chat");
    addChat("brain", result.reply, { meta: result._meta });
    broadcast({ type: "brainDone" });
    mergeFindings(result.findings, result.filesInvestigated);

    if (result.statusUpdates && result.statusUpdates.length) {
      for (const update of result.statusUpdates) {
        if (!update.id || !update.status) continue;
        const f = findings.find(f => f.id === update.id);
        if (f && f.status !== update.status) {
          f.status = update.status;
          broadcastFindingUpdate(update.id, update.status);
        }
      }
      saveFindings();
      broadcastState();
    }

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
    broadcastState();
    drainPendingChat();
  } catch (e) {
    addChat("error", "Brain error: " + e.message);
    broadcast({ type: "brainDone" });
    chatBusy = false;
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

let continueQueue = 0;

async function runCycle() {
  if (!running) return;
  if (state === "CHECKING") {
    console.log("[cycle] Already running — skipping");
    scheduleNextCycle();
    return;
  }

  if (continueQueue > 0) {
    continueQueue--;
    broadcastState();
    const ok = await sendToApp("continue");
    if (!ok) continueQueue++;
    scheduleNextCycle();
    return;
  }

  cycleCount++;

  const now = Date.now();
  const STALE_MS = 60 * 60 * 1000;
  let lifecycleChanges = 0;
  for (const f of findings) {
    const age = f.sentAt ? now - new Date(f.sentAt).getTime() : Infinity;
    if ((f.status === "sent" || f.status === "received") && age > STALE_MS) {
      f.status = "ignored";
      f.expiredAt = new Date().toISOString();
      lifecycleChanges++;
    }
    if (f.status === "identified" && !f.pendingPrompt && !(f.messages?.some(m => m.status === "pending"))) {
      const firstAge = f.firstSeen ? now - new Date(f.firstSeen).getTime() : 0;
      if (firstAge > STALE_MS) {
        f.status = "ignored";
        f.expiredAt = new Date().toISOString();
        lifecycleChanges++;
      }
    }
  }
  if (lifecycleChanges) { saveFindings(); console.log(`[cycle] Auto-expired ${lifecycleChanges} stale finding(s)`); }

  state = "CHECKING";
  broadcastState();
  startThinkingGuard();
  broadcast({ type: "brainStart" });

  const buf = await takeScreenshot();
  if (!buf) { clearThinkingGuard(); scheduleNextCycle(); return; }
  fs.writeFileSync(SCREENSHOT_PATH, buf);

  const idle = await isDesktopIdle(buf);
  if (!idle) {
    console.log("[cycle] Skipped — Claude Desktop busy");
    broadcast({ type: "brainDone" });
    clearThinkingGuard();
    cycleHistory.unshift({ cycle: cycleCount, time: new Date().toLocaleTimeString(), status: "skipped", sent: false, topic: "Claude Desktop busy — skipped" });
    if (cycleHistory.length > 20) cycleHistory.pop();
    scheduleNextCycle();
    return;
  }

  try {
    const prompt = buildBrainPrompt(null);
    const result = await callBrain(prompt);
    addChat("brain", result.reply, { auto: true, meta: result._meta });
    broadcast({ type: "brainDone" });

    if (result.lastSendResult && sendsPending > 0) {
      sendsPending--;
      if (result.lastSendResult === "delivered") sendsDelivered++;
      else if (result.lastSendResult === "ignored") sendsIgnored++;
    }

    mergeFindings(result.findings, result.filesInvestigated);

    if (result.statusUpdates && result.statusUpdates.length) {
      for (const update of result.statusUpdates) {
        if (!update.id || !update.status) continue;
        const f = findings.find(f => f.id === update.id);
        if (f && f.status !== update.status) {
          f.status = update.status;
          broadcastFindingUpdate(update.id, update.status);
        }
      }
      saveFindings();
      broadcastState();
    }

    if (result.newGoals && result.newGoals.length) {
      for (const ng of result.newGoals) {
        if (!ng.title || !ng.project) continue;
        if (!goalsData.projects[ng.project]) goalsData.projects[ng.project] = { description: "", goals: [] };
        const existing = goalsData.projects[ng.project].goals;
        const isDup = existing.some(g => similarity(g.title, ng.title) > 0.5);
        if (!isDup && existing.length < 15) {
          existing.push({
            id: `goal-${ng.project}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: ng.title,
            source: ng.source || "brain",
            priority: existing.length + 1,
            status: "active",
            created: new Date().toISOString(),
            insights: [],
          });
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

    if (result.question && !isDuplicate(result.question)) {
      const qId = `question-${Date.now()}`;
      const nowISO = new Date().toISOString();
      const qFinding = {
        id: qId, type: "question", title: result.question.slice(0, 80),
        detail: result.question, project: activeProjects[0] || null,
        status: "identified", pendingPrompt: result.question,
        firstSeen: nowISO, lastSeen: nowISO,
        messages: [{ text: result.question, status: "pending", addedAt: nowISO }],
      };
      findings.push(qFinding);
      saveFindings();
      addChat("finding", qFinding.title, { finding: { ...qFinding } });
      broadcast({ type: "suggestedPrompt", prompt: result.question, title: "Question: " + result.question.slice(0, 50), findingId: qId });
    }

    if (result.suggestedPrompt && !isDuplicate(result.suggestedPrompt) && !isSuggestionDuplicate(result.suggestedPrompt)) {
      broadcast({ type: "suggestedPrompt", prompt: result.suggestedPrompt, title: result.suggestedTitle || null, findingId: result.suggestedFindingId || null });
      suggestedHistory.unshift(result.suggestedPrompt);
      if (suggestedHistory.length > 20) suggestedHistory.pop();
    }

    let sent = false;
    if (result.status === "active") {
      let promoted = 0;
      for (const f of findings) {
        if (f.status === "sent") {
          f.status = "received";
          f.receivedAt = new Date().toISOString();
          broadcastFindingUpdate(f.id, "received");
          promoted++;
        }
      }
      if (promoted) { saveFindings(); }
    }

    // Finding pipeline: pick top-priority identified finding with a prompt
    const projectCtx2 = gatherProjectContext();
    const cwdProject = projectCtx2.cwd ? path.basename(projectCtx2.cwd) : null;
    const typePriority = { bug: 0, improvement: 1, feature: 2, debt: 3 };
    const hasPendingMessage = (f) => f.pendingPrompt || (f.messages && f.messages.some(m => m.status === "pending"));
    const sendCandidate = activeProjects.length === 0 ? null : findings
      .filter(f => f.status === "identified" && hasPendingMessage(f))
      .filter(f => activeProjects.some(p => f.project && f.project.includes(p)))
      .sort((a, b) => {
        const isActive = (p) => activeProjects.some(ap => p && p.includes(ap));
        const aActive = isActive(a.project) ? 0 : 1;
        const bActive = isActive(b.project) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const ratingOrder = { good: 0, undefined: 1, bad: 2 };
        const ra = ratingOrder[a.rating] ?? 1;
        const rb = ratingOrder[b.rating] ?? 1;
        if (ra !== rb) return ra - rb;
        return (typePriority[a.type] ?? 2) - (typePriority[b.type] ?? 2);
      })[0];

    if (sendCandidate) {
      const promptToSend = sendCandidate.pendingPrompt
        || (sendCandidate.messages && sendCandidate.messages.find(m => m.status === "pending"))?.text;

      if (promptToSend && !isDuplicate(promptToSend)) {
        const sendCtx = { id: sendCandidate.id, type: sendCandidate.type || "message", title: sendCandidate.title };

        if (muteMode) {
          broadcastFindingUpdate(sendCandidate.id, "queued");
        } else {
          broadcastFindingUpdate(sendCandidate.id, "preview", { prompt: promptToSend, countdown: 10 });
          addChat("system", `Sending in 10s: "${promptToSend.slice(0, 80)}..."`);

          let cancelled = false;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            broadcast({ type: "sendCountdown", findingId: sendCandidate.id, remaining: 9 - i });
            reloadFindingsFromDisk();
            const current = findings.find(f => f.id === sendCandidate.id);
            if (!current || current.status === "ignored") {
              cancelled = true;
              addChat("system", `Send cancelled.`);
              break;
            }
          }

          if (!cancelled) {
            const freshBuf = await takeScreenshot();
            if (freshBuf) fs.writeFileSync(SCREENSHOT_PATH, freshBuf);
            const stillIdle = freshBuf ? await isDesktopIdle(freshBuf) : true;
            broadcastFindingUpdate(sendCandidate.id, "sending", { prompt: promptToSend });
            if (stillIdle) {
              sent = await sendToApp(promptToSend, sendCtx);
              if (sent) {
                sendCandidate.status = "sent";
                sendCandidate.sentPrompt = promptToSend;
                sendCandidate.sentAt = Date.now();
                delete sendCandidate.pendingPrompt;
                if (sendCandidate.messages) {
                  const msg = sendCandidate.messages.find(m => m.text === promptToSend && m.status === "pending");
                  if (msg) msg.status = "sent";
                }
                saveFindings();
                broadcastFindingUpdate(sendCandidate.id, "sent", { prompt: sendCandidate.sentPrompt });
              }
            } else {
              broadcastFindingUpdate(sendCandidate.id, "held");
            }
          }
        }
      }
    }

    const topicSummary = (result.suggestedPrompt || result.reply || "").slice(0, 100);
    cycleHistory.unshift({
      cycle: cycleCount,
      time: new Date().toLocaleTimeString(),
      status: result.status || "idle",
      sent,
      duration: result._meta?.duration || 0,
      topic: topicSummary,
    });
    if (cycleHistory.length > 20) cycleHistory.pop();

    // Auto-re-send stuck findings
    const RESEND_AFTER_MS = 300000;
    const sentFindings = findings.filter(f => f.status === "sent" && f.sentPrompt && f.sentAt);
    for (const f of sentFindings) {
      const resendCount = f.resendCount || 0;
      if (resendCount >= 1) {
        f.status = "failed";
        broadcastFindingUpdate(f.id, "failed");
        saveFindings();
        break;
      }
      if (Date.now() - f.sentAt > RESEND_AFTER_MS) {
        broadcastFindingUpdate(f.id, "resending");
        await sendToApp(f.sentPrompt);
        f.sentAt = Date.now();
        f.resendCount = resendCount + 1;
        saveFindings();
        break;
      }
    }

    clearThinkingGuard();
    scheduleNextCycle();
    drainPendingChat();
  } catch (e) {
    cycleHistory.unshift({
      cycle: cycleCount,
      time: new Date().toLocaleTimeString(),
      status: "error",
      sent: false,
      error: e.message.slice(0, 80),
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
  addChat("system", "Autopilot started — checking every " + settings.interval + "s.");
  loopTimer = setTimeout(() => runCycle(), 3000);
}

function stop() {
  running = false;
  state = "IDLE";
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  addChat("system", "Autopilot stopped.");
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
        if (!id || !status) { res.writeHead(400); res.end(JSON.stringify({ error: "id and status required" })); return; }
        reloadFindingsFromDisk();
        const f = findings.find(f => f.id === id);
        if (!f) { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return; }
        const oldStatus = f.status;
        f.status = status;
        saveFindings();
        broadcastState();
        broadcastFindingUpdate(id, status);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, oldStatus, newStatus: status }));
      } catch (e) {
        res.writeHead(400);
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
          goalsData.projects[project].goals.push({
            id: `goal-${project}-${Date.now()}`, title, source: "user", priority: priority || 1, status: "active", created: new Date().toISOString(), insights: [],
          });
          saveGoals(); broadcastState();
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } else if (action === "update" && goalId) {
          for (const p of Object.values(goalsData.projects)) {
            const goal = (p.goals || []).find(g => g.id === goalId);
            if (goal) { if (title) goal.title = title; if (priority) goal.priority = priority; if (status) goal.status = status; }
          }
          saveGoals(); broadcastState();
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } else if (action === "setMission" && title) {
          goalsData.mission = title; userGuidance = title;
          saveGoals(); broadcastState();
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } else if (action === "remove" && goalId) {
          for (const p of Object.values(goalsData.projects)) { p.goals = (p.goals || []).filter(g => g.id !== goalId); }
          saveGoals(); broadcastState();
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: "invalid action" }));
        }
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "state", running, state, cycleCount,
    interval: settings.interval,
    uptime: Date.now() - startTime, memoryFiles: memoryFileCount,
    brainModel: "claude-opus-4-6",
    guidance: userGuidance,
    activeProjects, allProjects, cycleHistory, findings, filesInvestigated,
    goals: goalsData,
  }));
  ws.send(JSON.stringify({ type: "chatLog", messages: chatLog }));
  if (cliLastScreen) ws.send(JSON.stringify({ type: "cli_terminal", content: cliLastScreen }));

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === "start") start();
      else if (msg.action === "stop") stop();
      else if (msg.action === "chat") {
        if (msg.text && msg.text.startsWith("autopilot:")) return;
        chatWithBrain(msg.text);
      } else if (msg.action === "sendDirect") {
        addChat("user", "[direct] " + msg.text);
        sendToApp(msg.text);
      } else if (msg.action === "guide") {
        loadGoals();
        goalsData.mission = msg.text;
        saveGoals();
        userGuidance = msg.text;
        broadcastState();
      } else if (msg.action === "setProjects") {
        activeProjects = msg.projects || [];
        try { atomicWriteSync(ACTIVE_PROJECTS_FILE, JSON.stringify(activeProjects)); } catch {}
        if (activeProjects.length > 0) {
          let cleared = 0;
          for (const f of findings) {
            if (f.pendingPrompt && f.project && !activeProjects.some(p => f.project.includes(p))) {
              delete f.pendingPrompt;
              cleared++;
            }
          }
          if (cleared > 0) saveFindings();
        }
        broadcastState();
      } else if (msg.action === "settings") {
        Object.assign(settings, msg.settings);
        addChat("system", "Interval: " + settings.interval + "s");
        broadcastState();
      } else if (msg.action === "getKnowledge") {
        ws.send(JSON.stringify({ type: "knowledge", ...loadKnowledge() }));
      } else if (msg.action === "sendSuggested") {
        if (msg.prompt) {
          if (isDuplicate(msg.prompt)) {
            console.log("[send] Blocked duplicate suggested send");
          } else {
            const ok = await sendToApp(msg.prompt);
            if (ok && msg.findingId) {
              reloadFindingsFromDisk();
              const f = findings.find(f => f.id === msg.findingId);
              if (f) { f.status = "sent"; f.sentPrompt = msg.prompt; f.sentAt = Date.now(); saveFindings(); broadcastState(); }
            }
          }
        }
      } else if (msg.action === "updateFinding") {
        if (msg.findingId && msg.status) {
          const f = findings.find(f => f.id === msg.findingId);
          if (f) {
            f.status = msg.status;
            if (msg.status === "sent" && msg.sentPrompt) { f.sentPrompt = msg.sentPrompt; f.sentAt = Date.now(); }
            saveFindings(); broadcastState();
          }
        }
      } else if (msg.action === "dismissFinding") {
        const f = findings.find(f => f.id === msg.findingId);
        if (f) { f.status = "ignored"; f.dismissedAt = new Date().toISOString(); saveFindings(); broadcastState(); }
      } else if (msg.action === "dismissAllFindings") {
        let count = 0;
        for (const f of findings) {
          if (["identified", "sent", "received"].includes(f.status)) {
            f.status = "ignored"; f.dismissedAt = new Date().toISOString(); count++;
          }
        }
        if (count) { saveFindings(); addChat("system", `Dismissed ${count} finding(s).`); }
        broadcastState();
      } else if (msg.action === "rateFinding") {
        if (msg.findingId && msg.rating) {
          const f = findings.find(f => f.id === msg.findingId);
          if (f) { f.rating = f.rating === msg.rating ? null : msg.rating; saveFindings(); broadcastState(); }
        }
      } else if (msg.action === "toggleMute") {
        muteMode = !muteMode;
        try { atomicWriteSync(MUTE_FILE, JSON.stringify({ muted: muteMode })); } catch {}
        if (muteMode) {
          addChat("system", "Mute ON — findings will queue.");
        } else {
          const queued = findings.filter(f => f.status === "queued");
          for (const f of queued) f.status = "identified";
          if (queued.length > 0) saveFindings();
          addChat("system", `Mute OFF — ${queued.length} queued finding(s) ready.`);
        }
        broadcastState();
      } else if (msg.action === "scanThreads") {
        const digest = scanRecentThreads();
        ws.send(JSON.stringify({ type: "threadScan", digest }));
        addChat("system", `Thread scan: ${Object.keys(digest.sessions).length} sessions indexed.`);
      } else if (msg.action === "regenerateVoice") {
        generateVoiceProfile();
      } else if (msg.action && msg.action.startsWith("cli_")) {
        cliHandleAction(msg);
      }
    } catch (e) {
      console.error("WebSocket message error:", e);
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

function startServer() {
  try {
    execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { timeout: 3000 });
  } catch {}
  setTimeout(() => {
    server.listen(PORT, () => {
      console.log(`Autopilot running at http://localhost:${PORT}`);
      console.log(`  Claude CLI: ${CLAUDE_PATH}`);
      console.log(`  Working dir: ${USER_CWD}`);
      console.log(`  Projects base: ${PROJECTS_BASE}`);
      console.log(`  Memory dir: ${MEMORY_DIR || "(none found)"}`);
      addChat("system", "Autopilot online — scanning threads...");
      const digest = scanRecentThreads();
      const sessionCount = Object.keys(digest.sessions).length;
      addChat("system", `Scanned ${sessionCount} recent sessions.`);

      // Load existing voice profile or generate one from thread history
      if (!loadVoiceProfile()) {
        addChat("system", "No voice profile found — generating from your message history...");
        generateVoiceProfile().then(() => {
          addChat("system", "Auto-starting...");
          broadcastState();
        }).catch(() => {});
      } else {
        addChat("system", "Voice profile loaded. Auto-starting...");
      }

      takeScreenshot().then(() => broadcastState()).catch(() => {});
      start();
    });
    server.on("error", (err) => {
      console.error("Server error:", err.message);
    });
  }, 1000);
}

startServer();
