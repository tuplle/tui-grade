// VINDEX: reference solution. A word index kept in a hand-written prefix tree (trie).
// State file vindex_index.txt: one line per (word, file) pair, "word<TAB>file<TAB>count". Files without any word
// leave no trace in it, so an empty index is an empty file.
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

const char *const INDEX_FILE = "vindex_index.txt";

// A node of the trie: children for a-z and 0-9, and (at the end of a word) the occurrences per input file.
struct Node {
    std::array<std::unique_ptr<Node>, 36> children;
    std::map<std::string, int> files;
    bool isWord() const { return !files.empty(); }
};

int slot(char c) { return std::isdigit(static_cast<unsigned char>(c)) ? 26 + (c - '0') : c - 'a'; }

class Trie {
public:
    void add(const std::string &word, const std::string &file, int count) {
        Node *node = &root_;
        for (char c : word) {
            std::unique_ptr<Node> &child = node->children[static_cast<size_t>(slot(c))];
            if (!child) child = std::make_unique<Node>();
            node = child.get();
        }
        node->files[file] += count;
    }

    const Node *find(const std::string &word) const {
        const Node *node = &root_;
        for (char c : word) {
            node = node->children[static_cast<size_t>(slot(c))].get();
            if (node == nullptr) return nullptr;
        }
        return node->isWord() ? node : nullptr;
    }

    // Depth-first walk over all words in alphabetical order.
    template <typename Visitor>
    void forEach(Visitor visit) const {
        std::string word;
        walk(root_, word, visit);
    }

private:
    template <typename Visitor>
    static void walk(const Node &node, std::string &word, Visitor &visit) {
        if (node.isWord()) visit(word, node);
        for (size_t i = 0; i < node.children.size(); ++i) {
            if (!node.children[i]) continue;
            word.push_back(i < 26 ? static_cast<char>('a' + i) : static_cast<char>('0' + (i - 26)));
            walk(*node.children[i], word, visit);
            word.pop_back();
        }
    }

    Node root_;
};

int total(const Node &node) {
    int sum = 0;
    for (const auto &entry : node.files) sum += entry.second;
    return sum;
}

void load(Trie &trie) {
    std::ifstream in(INDEX_FILE);
    std::string line;
    while (std::getline(in, line)) {
        std::istringstream fields(line);
        std::string word, file, count;
        if (std::getline(fields, word, '\t') && std::getline(fields, file, '\t') && std::getline(fields, count)) {
            trie.add(word, file, std::stoi(count));
        }
    }
}

void save(const Trie &trie) {
    std::ofstream out(INDEX_FILE, std::ios::trunc);
    trie.forEach([&out](const std::string &word, const Node &node) {
        for (const auto &entry : node.files) out << word << '\t' << entry.first << '\t' << entry.second << '\n';
    });
}

// Lowercases a token and drops everything that is not a letter or a digit ("Word." -> "word").
std::string normalize(const std::string &token) {
    std::string word;
    for (char c : token) {
        unsigned char u = static_cast<unsigned char>(c);
        if (u < 128 && std::isalnum(u)) word.push_back(static_cast<char>(std::tolower(u)));
    }
    return word;
}

std::set<std::string> indexedFiles(const Trie &trie) {
    std::set<std::string> files;
    trie.forEach([&files](const std::string &, const Node &node) {
        for (const auto &entry : node.files) files.insert(entry.first);
    });
    return files;
}

int fail(const std::string &message) {
    std::cerr << "Error: " << message << "\n";
    return 1;
}

void printHelp() {
    std::cout << "VINDEX - Help\n"
                 "Usage: vindex <command> [argument]\n"
                 "Commands:\n"
                 "  index FILE   Add a text file to the index\n"
                 "  search WORD  Find the files that contain a word\n"
                 "  stats        Show statistics of the index\n"
                 "  clear        Remove everything from the index\n"
                 "  help         Show this help\n";
}

int cmdIndex(const std::vector<std::string> &args, Trie &trie) {
    if (args.size() < 2) return fail("missing argument: path of a text file");
    const std::string &path = args[1];
    std::ifstream in(path);
    if (!in) return fail("file not found: " + path);
    if (indexedFiles(trie).count(path) > 0) {
        std::cout << "File " << path << " is already indexed, ignoring it.\n";
        return 0;
    }
    std::map<std::string, int> counts;
    std::string token;
    while (in >> token) {
        std::string word = normalize(token);
        if (!word.empty()) counts[word]++;
    }
    for (const auto &entry : counts) trie.add(entry.first, path, entry.second);
    save(trie);
    std::cout << "File " << path << " was indexed: " << counts.size() << " unique words.\n";
    return 0;
}

int cmdSearch(const std::vector<std::string> &args, const Trie &trie) {
    if (args.size() < 2) return fail("missing argument: the word to search for");
    std::string word = normalize(args[1]);
    const Node *node = word.empty() ? nullptr : trie.find(word);
    if (node == nullptr) {
        std::cout << "The word '" << args[1] << "' was not found in the index.\n";
        return 0;
    }
    std::cout << "The word '" << word << "' occurs in:\n";
    for (const auto &entry : node->files) std::cout << "  " << entry.first << ": " << entry.second << "\n";
    std::cout << "Total occurrences: " << total(*node) << "\n";
    return 0;
}

int cmdStats(const Trie &trie) {
    std::vector<std::pair<std::string, int>> words;
    trie.forEach([&words](const std::string &word, const Node &node) { words.emplace_back(word, total(node)); });
    std::set<std::string> files = indexedFiles(trie);
    std::cout << "Unique words: " << words.size() << "\nProcessed files: " << files.size() << "\n";
    for (const std::string &file : files) std::cout << "  " << file << "\n";
    // stable_sort keeps the alphabetical order of equally frequent words
    std::stable_sort(words.begin(), words.end(), [](const auto &a, const auto &b) { return a.second > b.second; });
    std::cout << "Top 5 words:\n";
    for (size_t i = 0; i < words.size() && i < 5; ++i) std::cout << "  " << i + 1 << ". " << words[i].first << " (" << words[i].second << ")\n";
    return 0;
}

}  // namespace

int main(int argc, char *argv[]) {
    std::vector<std::string> args(argv + 1, argv + argc);
    if (args.empty()) return fail("missing command, see --help");
    const std::string &command = args[0];
    if (command == "--help" || command == "help") {
        printHelp();
        return 0;
    }

    Trie trie;
    load(trie);
    if (command == "clear") {
        std::ofstream(INDEX_FILE, std::ios::trunc);
        std::cout << "The index was cleared.\n";
        return 0;
    }
    save(trie);  // the state file exists (empty at worst) after any run
    if (command == "index") return cmdIndex(args, trie);
    if (command == "search") return cmdSearch(args, trie);
    if (command == "stats") return cmdStats(trie);
    return fail("unknown command: " + command);
}
