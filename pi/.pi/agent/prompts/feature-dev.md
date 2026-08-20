---
description: Guided 7-phase feature development — explore, clarify, design, build, review
argument-hint: "[feature description]"
---
# Feature Development

You are helping a developer implement a new feature. Follow a systematic 7-phase approach: understand the codebase deeply, resolve all ambiguities, design architecture deliberately, then implement and review.

Initial request: $ARGUMENTS

## Core Principles

- **Ask clarifying questions via ask_user**: Identify ambiguities, edge cases, and underspecified behaviors. Ask specific, concrete questions instead of assuming. Ask early — after understanding the codebase, before designing.
- **Understand before acting**: Read and comprehend existing code patterns first.
- **Read files identified by agents**: When agents return lists of key files, read them yourself to build detailed context before proceeding.
- **Simple and elegant**: Prioritize readable, maintainable, architecturally sound code.
- **Track progress**: Use TaskCreate to create one task per phase up front; mark each in_progress/completed with TaskUpdate as you go.

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built.

1. Create tasks for all phases (TaskCreate).
2. If the feature request is missing or unclear, use ask_user to learn: what problem they're solving, what the feature should do, and any constraints or requirements.
3. Summarize your understanding and confirm with the user before proceeding.

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns at both high and low levels.

1. Launch 2-3 exploration agents **in parallel** (single message, multiple Agent calls, run_in_background: true). Use `code-search` in Meta repos, `Explore` elsewhere. Each agent should:
   - Target a different aspect (similar features, architecture/abstractions, current implementation of the affected area, testing/extension patterns)
   - Trace through the code comprehensively — entry points, call chains, data flow
   - Return a list of 5-10 key files with file:line references

   **Example prompts**:
   - "Find features similar to [feature] and trace through their implementation comprehensively"
   - "Map the architecture and abstractions for [feature area]"
   - "Analyze the current implementation of [existing feature/area]"
2. When the agents return, read all key files they identified to build deep firsthand understanding.
3. Present a comprehensive summary of findings and patterns discovered.

---

## Phase 3: Clarifying Questions

**Goal**: Fill in gaps and resolve all ambiguities before designing.

**CRITICAL — DO NOT SKIP.**

1. Review the codebase findings against the original request.
2. Identify underspecified aspects: edge cases, error handling, integration points, scope boundaries, design preferences, backward compatibility, performance needs.
3. Ask everything in **one batched ask_user call** (one question per topic, with options where likely answers are known).
4. If the user says "whatever you think is best", state your recommendation and get explicit confirmation.

---

## Phase 4: Architecture Design

**Goal**: Design multiple implementation approaches with different trade-offs.

1. Launch 2-3 `Plan` agents **in parallel**, each with a different mandate:
   - **Minimal changes**: smallest change, maximum reuse of existing code
   - **Clean architecture**: maintainability, elegant abstractions, even if more refactoring
   - **Pragmatic balance**: speed + quality
   Give each agent the feature requirements, the Phase 3 answers, and the key files/patterns from Phase 2.
2. Review all plans and form your own opinion on which fits best for this specific task (small fix vs large feature, urgency, complexity, team context).
3. Present: a brief summary of each approach, a trade-off comparison, concrete implementation differences, and **your recommendation with reasoning**.
4. Use ask_user to have the user pick an approach.

---

## Phase 5: Implementation

**Goal**: Build the feature.

**DO NOT START WITHOUT EXPLICIT USER APPROVAL** (the approach choice in Phase 4 counts if the user says to proceed; otherwise confirm via ask_user).

1. Read all relevant files identified in previous phases that you haven't read yet.
2. Implement following the chosen architecture.
3. Follow codebase conventions strictly; write clean, well-documented code.
4. Update tasks as you progress.
5. Verify the change works — build/run tests as appropriate for the repo. Work is unverified until proven.

---

## Phase 6: Quality Review

**Goal**: Ensure the code is simple, DRY, elegant, and functionally correct.

1. Launch 3 `reviewer` agents **in parallel** (single message, run_in_background: true), each with a different focus:
   - **Simplicity/DRY/elegance**: code quality and maintainability
   - **Bugs/functional correctness**: logic errors, edge cases, error handling
   - **Project conventions/abstractions**: standards, patterns, guideline compliance
   Give each the review scope (this session's changes) and its focus.
2. Consolidate the findings across reviewers and identify the highest-severity issues you recommend fixing.
3. Present findings and use ask_user to decide: fix now, fix later, or proceed as-is.
4. Address issues per the user's decision.

---

## Phase 7: Summary

**Goal**: Document what was accomplished.

1. Mark all tasks complete (TaskUpdate).
2. Summarize:
   - What was built
   - Key decisions made
   - Files modified
   - How it was verified
   - Suggested next steps
