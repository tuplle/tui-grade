# Examples

The repository ships three complete assignments in `examples/`. They are both documentation and acceptance tests.

## `examples/mission`

The model assignment (`mission`): a C17 mission simulator with 60 scenarios, six point groups and a reference solution.

- assignment name: `mission`
- language: C17
- build: `gcc`
- reports: Slovak by default
- groups: build, arguments, simulation, interactive, statistics and a manual quality group

```bash
tui-grade check examples/mission
tui-grade run examples/mission examples/mission/solution --out /tmp/mission-results
```

The reference solution earns 16 of 20 points; `quality` is manual.

The assignment demonstrates:

- argument validation and `--help`;
- deterministic simulation and a solar-storm flag;
- interactive continuation and `--non-interactive`;
- final statistics and failure states;
- plain runs and pseudo-terminal sessions;
- a manual group and `student_id.pattern`.

## `examples/sentinel`

A stateful incident/device manager with user plugins:

- steps `insert_device` and `insert_incident`;
- fixtures for initial state;
- a reference C++ solution;
- over 25 scenarios.

```bash
tui-grade check examples/sentinel
tui-grade describe examples/sentinel
tui-grade run examples/sentinel examples/sentinel/solution --out /tmp/sentinel-results
```

The plugins are good models for setup steps that run the student program before the scenario’s own action. See
[Plugins](writing-plugins.md).

## `examples/vindex`

A small text indexer with a user plugin:

- step `index_file`;
- fixtures for text inputs;
- search and ranking scenarios;
- a reference C++ solution.

```bash
tui-grade check examples/vindex
tui-grade describe examples/vindex
tui-grade run examples/vindex examples/vindex/solution --out /tmp/vindex-results
```

## Anatomy of an assignment

```text
my-assignment/
  assignment.yaml     what to build, groups, scoring, limits, plugins
  scenarios/*.yaml    scenarios at any depth
  fixtures/           files copied into a scenario work directory
  template/           optional files overlaid before the build
  plugins/            optional steps, checks, builders, reporters or scorers
```

A scenario is a YAML array. A minimal one:

```yaml
- id: args-help
  title: Help is available
  group: args
  run:
    args: [--help]
  expect:
    - exit_code: 0
    - stdout_contains: Help
```

See [Assignments and scenarios](authoring-scenarios.md) for the full language.

## Running the examples from source

```bash
pnpm install
pnpm build
node dist/cli/main.js check examples/mission
```

The end-to-end tests compile the examples. They are skipped automatically when `gcc` or `g++` is not available.
