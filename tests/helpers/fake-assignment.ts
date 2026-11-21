// A small assignment whose "students" are shell scripts built with the `custom` builder (no compiler needed).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FakeEnv {
  root: string;
  assignment: string;
  input: string;
  marker: string;
}

/** `marker` is created by the build command, so it proves whether a build (a student process) ever ran. */
const assignmentYaml = (marker: string): string => `name: Fake
max_points: 20
build:
  type: custom
  command: touch '${marker}' && mkdir -p bin && cp src/prog.sh bin/prog && chmod +x bin/prog
binary: bin/prog
project_root_marker: src/prog.sh
limits: { run_timeout_sec: 2, build_timeout_sec: 20 }
groups:
  - { id: structure, title: { en: Structure, sk: Struktura }, points: 4 }
  - { id: behaviour, title: { en: Behaviour, sk: Spravanie }, points: 12, requires_build: true }
  - { id: review, title: Review, points: 4, manual: true }
`;

export const SCENARIOS = `- id: "1-1"
  title: { en: Clean exit, sk: Cisty koniec }
  group: structure
  steps:
    - run: { args: [] }
  expect:
    - exit_code: 0
- id: "2-\${mode}"
  title: { en: "Mode \${mode}", sk: "Rezim \${mode}" }
  group: behaviour
  matrix:
    mode: [fast, slow]
  steps:
    - run: { args: [] }
  expect:
    - stdout_contains: ok
    - exit_code: 0
`;

export async function fakeAssignment(root: string, over: { scenarios?: string } = {}): Promise<FakeEnv> {
  const assignment = join(root, 'assignment');
  const marker = join(root, 'build-ran.marker');
  await mkdir(join(assignment, 'scenarios'), { recursive: true });
  await writeFile(join(assignment, 'assignment.yaml'), assignmentYaml(marker));
  await writeFile(join(assignment, 'scenarios', 's.yaml'), over.scenarios ?? SCENARIOS);
  const input = join(root, 'input');
  await mkdir(input, { recursive: true });
  return { root, assignment, input, marker };
}

export const GOOD = '#!/bin/sh\necho ok\n';
export const BAD = '#!/bin/sh\necho nope\nexit 3\n';

/** Adds a student folder; a `null` script leaves the project root marker out (structure failure). */
export async function addStudent(env: FakeEnv, name: string, script: string | null): Promise<void> {
  const dir = join(env.input, name);
  await mkdir(join(dir, 'src'), { recursive: true });
  if (script !== null) await writeFile(join(dir, 'src', 'prog.sh'), script);
}
