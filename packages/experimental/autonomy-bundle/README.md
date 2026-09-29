---
description: "Add the autonomy stack and its Autonomy page from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-autonomy-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle adds the two Autonomy rows that the shipped Web composition leaves out: `autonomy` and `ui-autonomy`. Shipped profiles keep it switched off.

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

Open Plugins in the Web sidebar and enable Autonomy. This mounts the autonomy stack: the safety core, memory, executive loop, efficiency, autonomy prompt, workflows and learning. Its state is kept under `<dsh home>/autonomy`, and the agent's default model plans and carries out steps. It also adds the Autonomy page to the sidebar, right after Tasks. That page shows the kill switch, owner approvals, goals with plan progress, the latest action, and spend. Evolution and the research layer stay off until you switch them on in the `autonomy` row's config. Disabling the bundle restores the shipped composition; stored state remains on disk.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts the two rows, and `package.json` depends on their packages so each row resolves from this bundle. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Inserts the `autonomy` and `ui-autonomy` rows |
| [`package.json`](package.json) | The row packages as dependencies |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Autonomy bundle](../../autonomy/autonomy/README.md): what each part does and how it is configured.
- [Autonomy page](../../client/ui-autonomy/README.md): the Web page this bundle adds.
- [Web bundle](../../bundle/web-app/README.md): the composition this bundle adds the rows to.

-----

<a id="model-experience"></a>
## Model Experience

### Autonomy tools and prompt

#### What the model sees

A live root Agent gains the autonomy tools (goals, plans, beliefs, memory, tool search, workflows, learning and guideline proposals) and the autonomy constitution plus learned guidelines in its system prompt.

#### Token effect

Selecting the bundle adds these tool schemas and the constitution text to every live root Agent request. Tool output compression can shorten long output from noisy tools.

#### KV Cache effect

The tool schemas and prompt text change the request prefix once when the bundle mounts. An accepted guideline edit changes the prompt again on the next request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- While the bundle is on, its page offers a switch per row, as for every bundle. Switching `autonomy` off leaves the Autonomy page without its Host service.
- A profile patch that targets `autonomy` or `ui-autonomy` by id matches no row while this bundle is not selected.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
