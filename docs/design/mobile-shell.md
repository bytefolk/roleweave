# RoleWeave mobile shells

Date: 2026-09-17
Status: split by OS

## Decision

Phone traffic is split into three shells. They share the workspace snapshot and command protocol, not the layout.

| Platform | Detection | Layout |
| --- | --- | --- |
| iOS | iPhone / iPad / iPod | Large title, inset grouped list, 49pt tab bar |
| Android | Android UA without Harmony | Material top app bar, full-bleed list, 80dp nav |
| HarmonyOS | HarmonyOS / OpenHarmony / ArkWeb first | Service cards, 20px radius, floating dock |

Force with `?platform=ios|android|harmony`. Desktop remains `?surface=desktop`.

Harmony wins when a UA contains both Android and HarmonyOS.

Turns still run on the desktop host. These shells do not hire or edit the org tree.
