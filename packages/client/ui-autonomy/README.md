---
description: "Web Autonomy page: kill switch, owner approvals, goals and plan progress, latest action, and spend."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-autonomy

English | [中文](README.zh.md)

## Summary

The Autonomy page lets the owner watch and steer the autonomy stack. It has a kill switch, a list of items waiting for a decision, goals with their plan progress, the latest actions, and spend. It is one first-level page in the sidebar, placed right after Tasks.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web composition has no `ui-autonomy` row. To add it, enable the optional bundle `@deepseek-ai/dsh-experimental-autonomy-bundle` from the Plugins page (Official group), or list it in a profile's `dsh.profile.bundles`. That mounts this page together with the Host `@deepseek-ai/dsh-autonomy` stack it reads.

The page header shows the agent's name and whether it is running or stopped. **Stop all** needs two presses: the first arms it and the second, within a few seconds, pulls the kill switch. **Resume** clears it. If no model is connected, a note says that only plans already written will run.

**Waiting for you** lists everything that needs the owner, oldest first:
- risky actions, with their risk level
- goals the agent proposed
- new workflows, and workflow runs paused at an approval step
- self-improvement candidates

Each item has **Approve** and **Reject**. A failed decision shows its error, and the item stays in the list.

**Goals** lists goals with their status and "done/total steps". The input at the top adds a goal for the agent to pursue. **Latest actions** lists recent steps and whether each succeeded. **Spend** shows cost, input and output tokens, and model and tool call counts from the run journal; it says so when the journal is off.

The page refreshes when the Host signals a change, and when the connection comes back. If the Host service is missing, the page says so and offers **Retry**.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry registers the `autonomy` main panel and its `sidebar.panellist` entry at `order: 11`, after Tasks (`order: 10`). It injects `remote.autonomyControl` and uses four calls from it: `snapshot`, `decide`, `setStopped` and `addGoal`. It listens for the `autonomy/changed` event. `source.ts` wraps these calls in an observable source: it reads a snapshot while someone is observing and re-reads on `autonomy/changed` or a connection reset. When the last observer unsubscribes, it drops its listeners and ignores late responses. The page holds only disposable state: the armed stop, the goal draft, and in-flight decisions. Everything else comes from the Host snapshot.

The Host side is `AutonomyControl` in `@deepseek-ai/dsh-autonomy` (`src/remote.ts`). It is mounted when that plugin's `controlPage` is on, which is the default. It returns one JSON snapshot and applies owner decisions through the same approval, goal and workflow services the agent uses.

No runtime invariant companion is published because the page renders Host-owned state and owns only disposable interaction state.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Autonomy bundle](../../autonomy/autonomy/README.md): the Host stack this page reads.
- [Experimental Autonomy bundle](../../experimental/autonomy-bundle/README.md): how to switch the page on.
- [Slots](../../../docs/subsystems/slots.md): panel and sidebar contributions.

<a id="model-experience"></a>
## Model Experience

This package adds no tools, prompt text or context of its own. Goals added and decisions made here reach the model only through the Host autonomy stack.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The page shows the latest actions and a spend summary, not the full run journal or audit log.
- Guidelines, workflows and memory are managed in chat or in their files, not on this page.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
