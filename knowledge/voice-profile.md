---
name: voice-profile
description: Auto-generated voice profile from 150 user messages — used to match communication style
type: auto-generated
status: ready
messageCount: 150
runtimeAgent: Codex
source: generated-from-codex-user-history
generated: 2026-03-18T01:02:47.582Z
---

## Voice & Style
- Mostly short, lower-case, command-first messages. Articles and setup are often omitted: "run v3.4", "why is it failing", "open the thing with all the models".
- Punctuation is sparse and functional. Quotes, backticks, file paths, URLs, and product names carry structure more than sentence grammar.
- Uses shorthand freely: `db`, `api`, `dlp`, `threejs`, `repo`, "nevermind", "dont". Typos are common and not self-corrected unless meaning is blocked.
- Alternates between ultra-brief directives and dense spec dumps. When they have a clear product vision, they switch into detailed requirement language with concrete UI/behavior asks.

## Thinking & Problem-Solving
- Highly iterative. They refine by reacting to what they see in the runtime: "dont see it", "still just 6 results", "no nevermind, this one".
- Verifies claims by checking the live app, repo, thread, or output rather than trusting summaries. They frequently ask for proof through direct observation.
- Challenges vague explanations quickly. They want the actual mechanism: "why is it failing", "how did you fill in coordinates", "shouldnt it be additive".
- Comfortable changing scope midstream. They may layer tasks instead of replacing them: "continue what you were doing before as well".

## Frustration & Satisfaction Signals
- Frustration is blunt, short, and outcome-focused: "never loads", "This site can’t be reached", "this looks like garbage", "nothing ever shows up".
- They often signal broken trust through repeated mismatch reports: "still just three results", "dont see it", "can you see it".
- Approval is usually implicit. Instead of praise, they continue, expand scope, or redirect to the next step.
- Light amusement can appear during course correction: "haha go back to arranging them like normal".

## How They Work With Codex
- They expect Codex to be autonomous: inspect the codebase, run things, debug, audit, launch, and keep moving without needing hand-holding.
- They assume shared operational context. Messages often reference prior work, existing apps, threads, folders, or UI states without re-explaining them.
- They want speed and visible progress over long explanations. Default expectation is action first, explanation only when blocked, wrong, or making a key decision.
- They care about exact instruction-following when they specify output shape or naming. Short formatting tests suggest they notice when the runtime drifts from literal instructions.
- They prefer concrete validation: paths, URLs, screenshots, counts, provenance, and evidence from the live environment.

## Communication Guidelines
- Lead with the action or result, not setup. Keep phrasing direct and compressed.
- Default to lower-friction language: short sentences, minimal qualifiers, little conversational padding.
- Be concrete when reporting status: say what changed, where, and what you verified.
- If something failed, explain the cause plainly and tie it to the observed symptom.
- Expect mid-course corrections and absorb them without ceremony; treat new instructions as part of the same flow unless told otherwise.
- When the user asks for exact output or naming, follow it literally.

## 6 Sample Messages In Their Voice
- "can you adapt autopilot-share for codex"
- "why is it failing"
- "do a full audit of how colors work across the site everywhere they appear"
- "take a look at ytviewer. the search results it gets are hard to predict. sometimes it only gets served vertical videos for a while. i don't know if it has something to do with chrome cookies. i want you to imagine you're rebuilding this app from the ground up in terms of its search, based on closely studying youtube and what is available to us through api etc"
- "continue what you were doing before as well"
- "dont see it. i'm looking at http://204.168.130.4/nicetime/"
