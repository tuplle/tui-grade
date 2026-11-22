# MISSION CONTROL – reference solution

Reference solution of the `examples/mission` assignment. It is the model project against which the
scenarios in `scenarios/` are verified: it earns the full automatic score (16 of 20 points; the remaining 4 points
for code quality are graded manually).

The program itself is in Slovak, as the assignment is: its output is Slovak, and its comments are in English like the
rest of the repository.

## Compilation

```bash
gcc -std=c17 -o bin/mission -Wall -Wextra src/main.c
```

## Usage

```bash
./bin/mission --help
./bin/mission --crew 2 --days 3 --food 6 --oxygen 12
./bin/mission --crew 2 --days 3 --food 6 --oxygen 12 --solar-storm 2 --non-interactive
```

The exit code is `0` for a valid simulation (even when the mission fails for lack of supplies) and `1` for invalid
arguments.
