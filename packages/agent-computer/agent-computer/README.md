---
description: "The agent's own persistent computer: a dedicated Docker machine with a persistent disk, optional desktop, snapshots, and model tools."
kind: "package"
---

# @deepseek-ai/dsh-agent-computer

English | [中文](README.zh.md)

## Summary

This package gives the agent its own dedicated Linux machine instead of the user's. The machine is created on first use and keeps its installed packages and home directory across sessions. It can be checkpointed and restored.

## Tools

| Tool | Purpose |
|---|---|
| `computer_exec` | Run a bash command on the agent's computer |
| `computer_write_file` / `computer_read_file` | Write or read a text file |
| `computer_status` | Report whether the machine exists and is running, and its desktop URL |
| `computer_snapshot` | Checkpoint the system and the disk under a tag |
| `computer_restore` | Roll back to a snapshot; registered only when `modelRestore: true` |

Other plugins can use the same machine through `ctx.agentComputer`.

## Isolation

- **No host access:** the host filesystem is never mounted; the only storage is a named volume at `/home/agent`.
- **Restricted container:** it never runs privileged, `no-new-privileges` is set, and CPU, memory and process counts are capped.
- **Network:** `network: none` makes the machine fully offline.
- **Desktop:** only reachable at `127.0.0.1:6080`.

## Requirements

Docker or Podman on the host.
