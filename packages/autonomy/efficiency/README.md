---
description: "Efficiency: ranked tool search with calibrated probabilities, compression of noisy tool output, and replayable run journals with per-call cost accounting."
kind: "package"
---

# @deepseek-ai/dsh-efficiency

English | [中文](README.zh.md)

## Summary

Provides `ctx.efficiency` with three features, each on by default and switchable in config. `tool_search` ranks the available tools for a described need and returns a probability for each, or says no tool is needed; a model-backed chooser can replace the built-in ranking via `ctx.efficiency.setChooser()`. Compression shrinks long output from noisy tools such as shells, command runners and fetchers before the model sees it: it removes colour codes, folds repeated lines, and for very long logs keeps the start, the end and every error or warning line. File reads are never compressed. The journal records every model call and tool call with duration, tokens and cost, using a per-model price table; `run_journal` replays a run and summarises spending. Token and dollar usage are also charged to the autonomy budget when `@deepseek-ai/dsh-autonomy-core` is loaded. The ideas come from OpenHuman; the code is written for dsh.
