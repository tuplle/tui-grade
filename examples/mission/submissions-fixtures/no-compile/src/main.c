// Project that does not compile: a semicolon is missing and a declaration is malformed.
#include <stdio.h>

static void print_help(void) {
    printf("Help\n");
}

static int parse_arguments(int argc, char **argv) {
    (void)argv;
    return argc > 1;
}

static int daily_oxygen(int crew) {
    return crew * 2;
}

static void print_summary(int days) {
    printf("Dokončené dni: %d\n", days);
}

int main(int argc, char **argv) {
    int days = parse_arguments(argc, argv)
    int oxygen = = daily_oxygen(2);
    print_help();
    print_summary(days + oxygen);
    return 0;
}
