# SENTINEL: example assignment with user plugins

A port of the hand-written tui-test project of the DSA 2026 course (semester project 1, a C++17 CLI `sentinel` with
the commands `new`, `list`, `add`, `fix`, `count`; state files `zariadenia.txt` and `incidenty.txt`) to the
declarative model: `assignment.yaml` plus `scenarios/*.yaml`.

| Path | What it is |
| --- | --- |
| `assignment.yaml` | build (`g++ -std=c++17`), limits, groups (2 + 5 + 5 + 4 points automatic, 4 manual) |
| `scenarios/*.yaml` | 39 scenarios; the incident types and the `y`/`n` answers are `matrix` scenarios |
| `plugins/insert-device.js`, `plugins/insert-incident.js` | user plugins: the steps `insert_device { name, ip }` and `insert_incident { ip, type }` (replace `insertDevice`/`insertIncident` of the old `sentinel-helpers.js`) |
| `plugins/support.js` | helper shared by the two plugins: runs the student binary as a setup action |
| `solution/` | reference solution (`solution/src/main.cpp`); its output is English |

## Plugins in a standalone project

The plugin files import the framework through `plugins/support.js`, which tries the repository sources first and then
the installed package, so the same files run inside this repository and in a project that has
`tui-grade` installed:

```js
const framework = await import('../../../src/index.ts').catch(() => import('tui-grade'));
```

In your own project you can simply write `import { definePlugin, runProcess, z } from 'tui-grade';`.

## Try it

```bash
tui-grade check examples/sentinel
tui-grade describe examples/sentinel          # lists insert_device and insert_incident
tui-grade run examples/sentinel examples/sentinel/solution
```
