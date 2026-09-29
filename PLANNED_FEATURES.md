# Planned Features

> Status: **BUILD APPROVED (2026-09-29)**. Phases 1–7 complete; later phases proceed in order.
> **Open flow:** this whole plan stays open to changes — any item can be added, edited, reordered, or removed at any time, including during/after build.
> Next step: planning (design + mapping onto existing `packages/`), then build on request.

---

## 1. General Autonomous Executive Agent

An agent with the following capabilities:

- Persistent identity
- Self-model
- Memory
- Perception
- World modeling
- Goals
- Reasoning
- Planning
- Intent authorization
- Autonomous execution
- Verified information
- Uncertainty awareness
- Resource management
- Security
- Recovery
- Learning
- Experimentation
- Capability acquisition
- Controlled self-modification
- Open-ended growth

### 1a. Research-oriented Subjectivity Layer (separate module)

A separate, research-only layer to investigate whether:

- persistent self-modeling,
- metacognition,
- integrated internal states, and
- continuous experience

could produce properties associated with machine consciousness, **without assuming such consciousness has actually been achieved**.

---

## 2. Universal Model Routing

- Builds on the existing universal plugin architecture.
- Routes requests to any provider for which an API key is supplied.
- **Auto-detects the provider from the API key** (e.g. by key format/prefix, with probing as a fallback).

---

## 3. SkillOpt integration

- Source: https://github.com/microsoft/SkillOpt
- To be researched during planning.

---

## 4. Cognee integration

- Source: https://github.com/topoteretes/cognee
- To be researched during planning (candidate backend for Memory / knowledge graph in §1).

---

## 5. Agent's Own Computer

- Give the agent its own dedicated computer/environment to operate in.
- Related existing packages to evaluate during planning: `sandbox`, `computer-use`, `browser-use`, `terminal`, `shell`, `ssh`.

---

## 6. Hindsight integration

- Source: https://github.com/vectorize-io/hindsight
- To be researched during planning (candidate for Memory / learning in §1, alongside Cognee in §4).

---

## 7. Helix — whole-system evolution via mutations

- Source: https://github.com/KE7/helix
- Purpose: evolve the **entire system** through mutations. This is possible because the whole thing is open and modular (see Open flow).
- Ties into §1 (learning, experimentation, controlled self-modification, open-ended growth).
- To be researched during planning, including guardrails: sandboxed trials, evaluation/fitness checks, rollback, and human approval before a mutation is promoted.

---

## Design principle: Open flow

- Nothing in this plan is final; the full system must remain open for changes.
- Architecture should stay modular/plugin-based (Cordis) so components (memory backends, routers, skills, subjectivity layer, etc.) can be swapped, added, or removed without rewrites.

---

## Change log

- 2026-09-29: Initial list saved (items 1–5).
- 2026-09-29: Added Hindsight (item 6) and the open-flow principle.
- 2026-09-29: Added Helix whole-system evolution (item 7).

---

# PROPOSED PLAN (draft v1, open for changes — nothing built yet)

## Research findings
- **SkillOpt**: text-space optimizer; improves `skill.md` files for frozen LLM agents using trajectories + validation-gated updates. Python.
- **Cognee**: knowledge-graph + vector memory engine (semantic/structured memory). Python.
- **Hindsight**: "agent memory that learns" — retain / recall / reflect; hook-based integrations (recall before prompt, retain after turn). Python server.
- **Helix**: evolutionary optimization of whole codebases; agent CLIs mutate code inside Docker sandboxes, an evaluator scores each candidate (`HELIX_RESULT` contract), a frontier keeps the best. Python.
- Existing dsh pieces to reuse: `llm` + `llm-pi-ai` (multi-provider), `credentials`, `skill`, `goal`, `subagent`, `jobs`, `schedule`, `sandbox`, `computer-use`, `browser-use`, `hooks`, `guard`, `storage`.

## Phases
- **Phase 0 — Foundations**: all new work as Cordis plugins under `packages/autonomy/*`; Python engines run as sidecar services behind TS seams; one "kill switch" + audit log.
- **Phase 1 — Universal model router**: key auto-detection (prefix/format → probe fallback), provider registry on top of `llm-pi-ai`, routing policies (cost / speed / quality / fallback), per-task model choice.
- **Phase 2 — Agent's own computer**: persistent VM/container per agent (Docker first), with desktop (computer-use), browser, shell, its own filesystem & persistent disk; snapshot/restore.
- **Phase 3 — Memory seam**: one `memory` interface with pluggable backends — Hindsight (episodic, learns from experience) + Cognee (knowledge graph/semantic); recall/retain hooks.
- **Phase 4 — Executive core**: identity & self-model store, world model, goal hierarchy (extends `goal`), planner, intent authorization (permission levels + human approval), autonomous loop (on `jobs`/`schedule`), verification & uncertainty (confidence scores, source checks), resource budgets (tokens/money/time), recovery (checkpoints, retries).
- **Phase 5 — Learning & growth**: SkillOpt improves skills from trajectories; capability acquisition (agent writes/installs new plugins in its computer, gated); experimentation sandbox.
- **Phase 6 — Evolution (Helix)**: mutate whole-system variants in sandboxes → benchmark eval → frontier → human-approved promotion → rollback.
- **Phase 7 — Subjectivity research layer**: separate, opt-in; persistent self-model, metacognition logs, integrated internal-state vector, continuous experience stream; instrumentation + measurement only, no consciousness claims.

## Suggestions
1. Build in order 1 → 2 → 3 first: each is useful alone and everything else depends on them.
2. Safety is non-negotiable for self-modification/evolution: sandbox-only mutations, eval gates, immutable core (safety + authorization plugins can't be mutated by the agent), human approval, full audit trail, budget caps.
3. Define an evaluation suite early (uses `benchmarks/`) — Helix and SkillOpt both need a fitness score.
4. Keep the Python services (Cognee, Hindsight, SkillOpt, Helix) optional; harness must still run without them.
5. Store key detection rules as data, so new providers are added without code.

## Build progress
- [x] **Phase 1 — Universal model router**: `packages/llm/llm-router` (key detection rules, env-name hints, read-only probing, env scanning, pi-ai route mounting, policy routing; 25 tests).
- [x] **Phase 2 — Agent's own computer**: `packages/agent-computer/agent-computer` (persistent Docker/Podman machine, volume-backed home, optional loopback desktop, system+disk snapshots/restore, 5–6 model tools, `ctx.agentComputer` service; 12 tests).
- [x] **Phase 3 — Memory**: `packages/memory/{memory,memory-hindsight,memory-cognee}` (`ctx.memory` fan-out/merge service with graceful degradation, local BM25 store, memory_retain/recall/reflect tools, Hindsight + Cognee REST backends, `services/memory/docker-compose.yml`; 13 tests).
- [x] **Phase 4 — Executive core**: `packages/autonomy/autonomy-core` (identity + versioned self-model, risk-classified authorization gate on every tool call, approval queue, protected immutable core, budgets, kill switch incl. `STOP` file, hash-chained audit log) and `packages/autonomy/executive` (goal hierarchy, world model with log-odds beliefs/decay/calibration, plan DAGs, verification checks, retries + circuit breaker, autonomous loop with memory recall/retain; goal_/plan_/belief_ tools).
- [x] **Phase 5 — Learning**: `packages/autonomy/learning` (SkillOpt-style validation-gated skill optimizer + upstream CLI bridge, statistical `experiment_run` on the agent computer, propose → test → owner-approved install pipeline for new skills/scripts).
- [x] **Phase 6 — Evolution**: `packages/autonomy/evolution` (Helix bridge: helix.toml + gate evaluator emitting HELIX_RESULT, background runs on helix/* branches, protected-core diff check, fresh-worktree re-evaluation, critical-risk owner-approved merge, revert rollback).
  - [x] **Limitless evolution** (user request): `mode: limitless` — unlimited generations (`maxGenerations: 0`), whole-repo mutation scope including the protected core; promotion always owner-approved (critical risk), protected-core changes also need `acknowledgeProtected`; kill switch stops the loop; promotion history persisted for rollback.
- [x] **Phase 7 — Subjectivity research layer**: `packages/autonomy/subjectivity` (opt-in, off by default, measurement-only; metacognition calibration, self-model stability, global-workspace availability, agency indicators; every report disclaims any consciousness claim).


## Reference notes

- `elder-plinius/CL4R1T4S` › `ANTHROPIC/Claude-Fable-5.1.md` (shared by the user): a leaked, third-party proprietary chat-product system prompt. Reviewed, but none of its text is copied into this repo, and it is not used as the agent's prompt. The dsh agent's own prompt stays in the repo's `system-prompt` packages, written in our own words.
