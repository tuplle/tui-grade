// MISSION CONTROL - space mission simulator (reference solution)
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define FOOD_PER_PERSON 1
#define OXYGEN_PER_PERSON 2
#define OXYGEN_PER_PERSON_STORM 2

typedef struct {
    int crew;
    int days;
    int food;
    int oxygen;
    int storm_day;      // 0 = no storm
    int random_storm;   // 1 = the storm day is chosen at random
    int non_interactive;
} Mission;

typedef enum { STATE_SUCCESS, STATE_EARLY, STATE_FAILED } State;

static void print_help(const char *program) {
    printf("Help - simulátor vesmírnej výpravy\n\n");
    printf("Použitie: %s --crew N --days N --food N --oxygen N [--solar-storm [DEN]] [--non-interactive]\n\n", program);
    printf("  --crew POCET        počet členov posádky (1 až 100)\n");
    printf("  --days POCET        plánovaný počet dní (1 až 365)\n");
    printf("  --food MNOZSTVO     počiatočná zásoba jedla (0 až 1000000)\n");
    printf("  --oxygen MNOZSTVO   počiatočná zásoba kyslíka (0 až 1000000)\n");
    printf("  --solar-storm [DEN] deň so slnečnou búrkou (bez hodnoty náhodný deň)\n");
    printf("  --non-interactive   bez otázok, simulácia sa vykoná automaticky\n");
    printf("  --help              vypíše túto nápovedu\n");
}

static void print_error(const char *message, const char *detail) {
    fprintf(stderr, "Chyba: %s%s%s\n", message, detail ? ": " : "", detail ? detail : "");
    fprintf(stderr, "Pre nápovedu spustite program s argumentom --help.\n");
}

// Converts text to an integer within <min, max>; returns 1 if the text is valid.
static int parse_int(const char *text, int min, int max, int *out) {
    char *end = NULL;
    long value;

    if (text[0] != '-' && (text[0] < '0' || text[0] > '9')) {
        return 0;
    }
    errno = 0;
    value = strtol(text, &end, 10);
    if (errno != 0 || *end != '\0' || end == text) {
        return 0;
    }
    if (value < min || value > max) {
        return 0;
    }
    *out = (int)value;
    return 1;
}

// Reads the value of the argument at position *i + 1; returns 1 if the value is valid.
static int read_value(int argc, char **argv, int *i, int min, int max, int *out) {
    const char *name = argv[*i];

    if (*i + 1 >= argc || strncmp(argv[*i + 1], "--", 2) == 0) {
        print_error("chýba hodnota argumentu", name);
        return 0;
    }
    (*i)++;
    if (!parse_int(argv[*i], min, max, out)) {
        print_error("neplatná hodnota (celé číslo v povolenom rozsahu)", name);
        return 0;
    }
    return 1;
}

// Returns 1 if everything is fine, 0 on error and 2 if help was requested.
static int parse_arguments(int argc, char **argv, Mission *m) {
    int seen[7] = {0};
    const char *names[7] = {"--crew", "--days", "--food", "--oxygen", "--solar-storm", "--non-interactive", "--help"};
    int storm_value = 0;

    memset(m, 0, sizeof(*m));
    for (int i = 1; i < argc; i++) {
        int index = -1;
        for (int k = 0; k < 7; k++) {
            if (strcmp(argv[i], names[k]) == 0) {
                index = k;
            }
        }
        if (index < 0) {
            print_error("neznámy argument", argv[i]);
            return 0;
        }
        if (seen[index]) {
            print_error("argument bol zadaný viackrát", argv[i]);
            return 0;
        }
        seen[index] = 1;

        if (index == 6) {
            return 2;
        } else if (index == 0 && !read_value(argc, argv, &i, 1, 100, &m->crew)) {
            return 0;
        } else if (index == 1 && !read_value(argc, argv, &i, 1, 365, &m->days)) {
            return 0;
        } else if (index == 2 && !read_value(argc, argv, &i, 0, 1000000, &m->food)) {
            return 0;
        } else if (index == 3 && !read_value(argc, argv, &i, 0, 1000000, &m->oxygen)) {
            return 0;
        } else if (index == 4) {
            if (i + 1 < argc && strncmp(argv[i + 1], "--", 2) != 0) {
                if (!read_value(argc, argv, &i, 1, 365, &storm_value)) {
                    return 0;
                }
                m->storm_day = storm_value;
            } else {
                m->random_storm = 1;
            }
        } else if (index == 5) {
            m->non_interactive = 1;
        }
    }

    for (int k = 0; k < 4; k++) {
        if (!seen[k]) {
            print_error("chýba povinný argument", names[k]);
            return 0;
        }
    }
    if (m->storm_day > m->days) {
        print_error("slnečná búrka je mimo plánovaného trvania misie", "--solar-storm");
        return 0;
    }
    if (m->random_storm) {
        srand((unsigned int)time(NULL));
        m->storm_day = rand() % m->days + 1;
    }
    return 1;
}

static int daily_oxygen(const Mission *m, int day) {
    int per_person = (day == m->storm_day) ? OXYGEN_PER_PERSON_STORM : OXYGEN_PER_PERSON;
    return m->crew * per_person;
}

static void print_header(const Mission *m) {
    printf("====== RIADIACE STREDISKO ======\n");
    printf("Posádka: %d\n", m->crew);
    printf("Plánované dni: %d\n", m->days);
    if (m->storm_day > 0) {
        printf("Slnečná búrka: deň %d\n", m->storm_day);
    } else {
        printf("Slnečná búrka: nie\n");
    }
    printf("Režim: %s\n", m->non_interactive ? "neinteraktívny" : "interaktívny");
    printf("--------------------------------\n");
}

static void print_day_report(const Mission *m, int day, int food_used, int oxygen_used, int food, int oxygen) {
    printf("DEŇ %d/%d\n", day, m->days);
    printf("Slnečná búrka: %s\n", day == m->storm_day ? "áno" : "nie");
    printf("Spotrebované jedlo: %d\n", food_used);
    printf("Spotrebovaný kyslík: %d\n", oxygen_used);
    printf("Zostávajúce jedlo: %d\n", food);
    printf("Zostávajúci kyslík: %d\n", oxygen);
    printf("--------------------------------\n");
}

// Returns 1 if the simulation should continue; 0 on 'n' or end of input.
static int ask_continue(void) {
    char line[64];

    for (;;) {
        printf("Pokračovať na ďalší deň? [y/n]: ");
        fflush(stdout);
        if (fgets(line, sizeof(line), stdin) == NULL) {
            printf("\nVstup sa skončil, simulácia sa predčasne ukončuje.\n");
            return 0;
        }
        line[strcspn(line, "\r\n")] = '\0';
        if (strcmp(line, "y") == 0 || strcmp(line, "Y") == 0) {
            return 1;
        }
        if (strcmp(line, "n") == 0 || strcmp(line, "N") == 0) {
            return 0;
        }
        printf("Neplatná odpoveď, zadajte y alebo n.\n");
    }
}

static void print_summary(const Mission *m, State state, int completed, int food, int oxygen) {
    const char *names[] = {"ÚSPEŠNE DOKONČENÁ", "PREDČASNE UKONČENÁ POSÁDKOU", "ZLYHANIE PRE NEDOSTATOK ZÁSOB"};

    printf("================================\n");
    printf("SÚHRN MISIE\n");
    printf("Stav: %s\n", names[state]);
    printf("Dokončené dni: %d/%d\n", completed, m->days);
    printf("Úspešnosť: %.2f%%\n", (double)completed / m->days * 100.0);
    printf("Jedlo: %d na začiatku, %d spotrebované, %d zostáva\n", m->food, m->food - food, food);
    printf("Kyslík: %d na začiatku, %d spotrebované, %d zostáva\n", m->oxygen, m->oxygen - oxygen, oxygen);
    printf("================================\n");
}

static void run_simulation(const Mission *m) {
    int food = m->food;
    int oxygen = m->oxygen;
    int completed = 0;
    State state = STATE_SUCCESS;

    print_header(m);
    for (int day = 1; day <= m->days; day++) {
        int food_need = m->crew * FOOD_PER_PERSON;
        int oxygen_need = daily_oxygen(m, day);

        if (food < food_need || oxygen < oxygen_need) {
            printf("Posádka nedokáže dokončiť deň %d, chýba:%s%s\n", day, food < food_need ? " jedlo" : "",
                   oxygen < oxygen_need ? " kyslík" : "");
            state = STATE_FAILED;
            break;
        }
        food -= food_need;
        oxygen -= oxygen_need;
        completed++;
        print_day_report(m, day, food_need, oxygen_need, food, oxygen);

        if (day < m->days && !m->non_interactive && !ask_continue()) {
            state = STATE_EARLY;
            break;
        }
    }
    print_summary(m, state, completed, food, oxygen);
}

int main(int argc, char **argv) {
    Mission mission;
    int status = parse_arguments(argc, argv, &mission);

    if (status == 2) {
        print_help(argv[0]);
        return 0;
    }
    if (status == 0) {
        return 1;
    }
    run_simulation(&mission);
    return 0;
}
