---
description: "Whole-system evolution via Helix: sandboxed mutations, evaluation gates, protected-core checks, owner-approved promotion and rollback."
kind: "package"
---

# @deepseek-ai/dsh-evolution

English | [中文](README.zh.md)

## Summary

Provides `ctx.evolution`, a bridge to [Helix](https://github.com/KE7/helix) (`pip install helix-evo`). `evolution_start` writes `helix.toml` and an evaluator script built from the configured gates, then runs Helix in the background; coding agents mutate copies of the repository on `helix/*` branches and the working branch is never touched. `evolution_status` lists candidates and flags any that touch the protected safety core. `evolution_review` re-scores a candidate in a clean worktree. `evolution_promote` merges an eligible candidate; it is critical risk, so it always needs owner approval, and candidates that change the protected core or fail the gate are refused. `evolution_rollback` reverts the last promotion.
