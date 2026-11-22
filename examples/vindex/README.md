# VINDEX: example assignment with a user plugin

A C++17 CLI `vindex` with the commands `index FILE`, `search WORD`, `stats`, `clear`, `help` and the state file
`vindex_index.txt`, ported to the declarative model.

| Path | What it is |
| --- | --- |
| `assignment.yaml` | build (`g++ -std=c++17`), limits, groups (2 + 5 + 4 + 3 + 2 points automatic, 4 manual) |
| `scenarios/*.yaml` | 29 scenarios |
| `fixtures/` | small purpose-made texts (the big book files of the old project are not needed): `one-word.txt`, `empty.txt`, `punctuation-only.txt`, `trailing-dot.txt`, `normalize.txt`, and the two texts `story.txt` / `notes.txt` with known word counts (`the` 5 + 2, `fox` 2 + 2, `dog` 2 + 0; 16 unique words) |
| `plugins/index-file.js` | user plugin: the step `index_file { file }` (replaces `indexFile` of the old `sentinel-helpers.js`): runs `index FILE` of the student program in the scenario workdir and keeps `vindex_index.txt` |
| `plugins/support.js` | helper of the plugin: imports the framework and runs the student binary as a setup action |
| `solution/` | reference solution (`solution/src/main.cpp`, a trie); its output is English |

The index file only holds words, so a file without words (empty or punctuation only) leaves the index file empty.

## Try it

```bash
tui-grade check examples/vindex
tui-grade describe examples/vindex            # lists index_file
tui-grade run examples/vindex examples/vindex/solution
```
