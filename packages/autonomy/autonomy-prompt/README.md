---
description: "Autonomy system prompt: a fixed constitution for the autonomous agent plus owner-approved guidelines the agent learns while chatting."
kind: "package"
---

# @deepseek-ai/dsh-autonomy-prompt

English | [中文](README.zh.md)

## Summary

Adds two sections to the system prompt. The constitution is a fixed set of rules for the autonomous agent: who it is, what it may do, how it plans and verifies, and how it handles uncertainty and honesty. It is filled in with live facts (identity, active goals, kill-switch state) and belongs to the protected core, so the agent cannot edit it. The learned-guidelines section stays open to change at any time. By default (`changes: open`) the agent edits it directly in chat with `prompt_edit`, whenever you ask it to add, change or remove a guideline, or when it learns something from a correction or a task. With `changes: approve`, it uses `prompt_propose` instead and every change waits for your approval. You can also edit the Markdown copy (`guidelines.md`, next to the JSON file) yourself; your edits are picked up on the next turn. Changes made by the agent are refused if they would weaken the safety rules. Every version is kept, so `prompt_revert` can restore any earlier one, and `prompt_guidelines` shows the current list and history.
