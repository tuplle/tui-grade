// SENTINEL: reference solution. Devices live in a map (std::map), incidents in a hand-written FIFO queue.
// State files (text, one record per line, fields separated by ';'):
//   zariadenia.txt  ip;name;incident_count
//   incidenty.txt   ip;timestamp;type
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

const char *const DEVICES_FILE = "zariadenia.txt";
const char *const INCIDENTS_FILE = "incidenty.txt";
const std::vector<std::string> INCIDENT_TYPES = {"ddos", "sql_injection", "xss", "brute_force", "broken_auth", "unknown"};

struct Device {
    std::string ip;
    std::string name;
    int incidents = 0;
};

struct Incident {
    std::string ip;
    long long timestamp = 0;
    std::string type;
};

// FIFO queue on a vector with a moving head: push at the back, pop at the front.
class IncidentQueue {
public:
    void push(const Incident &incident) { items_.push_back(incident); }
    const Incident &front() const { return items_[head_]; }
    void pop() { ++head_; }
    size_t size() const { return items_.size() - head_; }
    bool empty() const { return size() == 0; }
    std::vector<Incident> toVector() const { return std::vector<Incident>(items_.begin() + static_cast<long>(head_), items_.end()); }

private:
    std::vector<Incident> items_;
    size_t head_ = 0;
};

std::vector<std::string> split(const std::string &line, char sep) {
    std::vector<std::string> parts;
    std::string part;
    std::istringstream in(line);
    while (std::getline(in, part, sep)) parts.push_back(part);
    return parts;
}

void loadDevices(std::map<std::string, Device> &devices) {
    std::ifstream in(DEVICES_FILE);
    std::string line;
    while (std::getline(in, line)) {
        std::vector<std::string> f = split(line, ';');
        if (f.size() < 3) continue;
        devices[f[0]] = Device{f[0], f[1], std::stoi(f[2])};
    }
}

void saveDevices(const std::map<std::string, Device> &devices) {
    std::ofstream out(DEVICES_FILE, std::ios::trunc);
    for (const auto &entry : devices) out << entry.second.ip << ';' << entry.second.name << ';' << entry.second.incidents << '\n';
}

void loadIncidents(IncidentQueue &queue) {
    std::ifstream in(INCIDENTS_FILE);
    std::string line;
    while (std::getline(in, line)) {
        std::vector<std::string> f = split(line, ';');
        if (f.size() < 3) continue;
        queue.push(Incident{f[0], std::stoll(f[1]), f[2]});
    }
}

void saveIncidents(const IncidentQueue &queue) {
    std::ofstream out(INCIDENTS_FILE, std::ios::trunc);
    for (const Incident &i : queue.toVector()) out << i.ip << ';' << i.timestamp << ';' << i.type << '\n';
}

bool isValidIp(const std::string &ip) {
    std::vector<std::string> octets = split(ip, '.');
    if (octets.size() != 4 || ip.back() == '.') return false;
    for (const std::string &octet : octets) {
        if (octet.empty() || octet.size() > 3) return false;
        for (char c : octet) {
            if (c < '0' || c > '9') return false;
        }
        if (std::stoi(octet) > 255) return false;
    }
    return true;
}

// Value of a named option (`--key value`), or an empty string when it is missing.
std::string option(const std::vector<std::string> &args, const std::string &key) {
    for (size_t i = 1; i + 1 < args.size(); ++i) {
        if (args[i] == key) return args[i + 1];
    }
    return "";
}

int fail(const std::string &message) {
    std::cerr << "Error: " << message << "\n";
    return 1;
}

void printHelp() {
    std::cout << "SENTINEL - Help\n"
                 "Usage: sentinel <command> [options]\n"
                 "Commands:\n"
                 "  new --name NAME --ip IP   Add a device\n"
                 "  list                      List devices\n"
                 "  add --ip IP [--type TYPE] Add an incident (ddos, sql_injection, xss, brute_force, broken_auth, unknown)\n"
                 "  fix                       Resolve the incident that is next in the queue\n"
                 "  count                     Print the number of queued incidents\n";
}

int cmdNew(const std::vector<std::string> &args, std::map<std::string, Device> &devices) {
    std::string name = option(args, "--name");
    std::string ip = option(args, "--ip");
    if (name.empty() && ip.empty()) return fail("missing arguments --name (device name) and --ip (IPv4 address)");
    if (name.empty()) return fail("missing argument --name (device name)");
    if (ip.empty()) return fail("missing argument --ip (IPv4 address)");
    if (!isValidIp(ip)) return fail("invalid IP address: " + ip);
    if (devices.count(ip) > 0) return fail("a device with the IP address " + ip + " already exists");
    devices[ip] = Device{ip, name, 0};
    saveDevices(devices);
    std::cout << "Device " << name << " (" << ip << ") was created.\n";
    return 0;
}

int cmdList(const std::map<std::string, Device> &devices) {
    if (devices.empty()) {
        std::cout << "No devices.\n";
        return 0;
    }
    for (const auto &entry : devices) {
        const Device &d = entry.second;
        std::cout << "----------------------\nIP: " << d.ip << "\nName: " << d.name << "\nIncidents: " << d.incidents << "\n";
    }
    std::cout << "----------------------\n";
    return 0;
}

int cmdAdd(const std::vector<std::string> &args, std::map<std::string, Device> &devices, IncidentQueue &queue) {
    std::string ip = option(args, "--ip");
    std::string type = option(args, "--type");
    if (type.empty()) type = "unknown";
    if (ip.empty()) return fail("missing argument --ip (IPv4 address)");
    bool knownType = false;
    for (const std::string &t : INCIDENT_TYPES) knownType = knownType || t == type;
    if (!knownType) return fail("unknown incident type: " + type);
    auto device = devices.find(ip);
    if (device == devices.end()) return fail("unknown device with the IP address " + ip);
    queue.push(Incident{ip, static_cast<long long>(std::time(nullptr)), type});
    device->second.incidents++;
    saveIncidents(queue);
    saveDevices(devices);
    std::cout << "Incident " << type << " was recorded for " << ip << ".\n";
    return 0;
}

int cmdFix(std::map<std::string, Device> &devices, IncidentQueue &queue) {
    if (queue.empty()) {
        std::cout << "The incident queue is empty.\n";
        return 0;
    }
    const Incident &incident = queue.front();
    std::cout << "Incident: " << incident.type << "\nDevice IP: " << incident.ip << "\nDevice name: " << devices[incident.ip].name
              << "\nTimestamp: " << incident.timestamp << "\n";
    std::string answer;
    while (true) {
        std::cout << "Was the incident resolved? [Y/N]: " << std::flush;
        if (!std::getline(std::cin, answer)) return 0;  // end of input: leave the queue untouched
        if (answer == "Y" || answer == "y") {
            queue.pop();
            saveIncidents(queue);
            std::cout << "Incident resolved and removed from the queue.\n";
            return 0;
        }
        if (answer == "N" || answer == "n") {
            std::cout << "Incident stays in the queue.\n";
            return 0;
        }
        std::cout << "Invalid input, answer Y or N.\n";
    }
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

    std::map<std::string, Device> devices;
    IncidentQueue queue;
    loadDevices(devices);
    loadIncidents(queue);
    saveDevices(devices);  // both files exist (empty at worst) after any run
    saveIncidents(queue);

    if (command == "new") return cmdNew(args, devices);
    if (command == "list") return cmdList(devices);
    if (command == "add") return cmdAdd(args, devices, queue);
    if (command == "fix") return cmdFix(devices, queue);
    if (command == "count") {
        std::cout << queue.size() << "\n";
        return 0;
    }
    return fail("unknown command: " + command);
}
