# Security Policy

## Supported versions

Security fixes are provided for the latest 1.x release. Older versions may not receive patches.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub’s private vulnerability reporting for this repository:

1. Open the **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, a description, reproduction steps, impact and any suggested fix.

If private reporting is not available, contact the maintainer through their GitHub profile and ask for a private
channel before sharing details.

We aim to acknowledge a report within a few days and will coordinate disclosure after a fix is available.

## Scope

In scope:

- the grading engine, CLI, plugin kernel, reporters and result files;
- the localhost dashboard and its API/security middleware;
- packaging, release artifacts and documentation that could mislead users about isolation.

Student code is **untrusted, and v1 has no sandbox and no container**. The documented behavior is in
[docs/security-and-limits.md](docs/security-and-limits.md). A deliberate program can read files, use the network, escape
its process group or exhaust resources; that is a known limit, not a vulnerability by itself. Report it if you find a
way to break the documented containment *beyond* those limits, or a way for one submission to affect other students or
the grading machine more than documented.

The localhost dashboard intentionally has no authentication. It binds only to `127.0.0.1` and keeps `Host`, `Origin`,
`X-TUI-Grade` and no-CORS checks. A report that assumes the server is exposed to a network is out of scope; exposing it
is unsupported.

## Safe testing

- Only test against systems and submissions you own or have permission to test.
- Do not run deliberately hostile student programs outside a disposable container or VM.
- Do not include real student data, credentials or tokens in a report.
- Keep reports minimal and reproducible; a tiny assignment and submission are enough.

## Thanks

Responsible reports help keep teachers and their grading machines safe. We will credit reporters who want to be named
once a fix is released.
