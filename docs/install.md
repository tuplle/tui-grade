# Install

`tui-grade` supports Linux, macOS (arm64/x64) and Windows x64, and requires Node.js 26 or newer. Windows ARM64 is not
supported by the native terminal package. There are three supported ways to get it.

## 1. npm package

When the release is published to npm:

```bash
# as a dependency of a grading project
pnpm add tui-grade
pnpm exec tui-grade --help

# or use it without installing globally
npx tui-grade
```

`npx tui-grade` starts the localhost dashboard. Use `npx tui-grade --help` for the CLI.

The npm package contains `dist/` (including the compiled dashboard), `package.json`, `README.md` and `LICENSE.txt`.
Dependencies are installed by npm/pnpm from the registry; `node_modules` is not bundled in the tarball.

The package installs on Linux, macOS and Windows x64. On Windows, use the x64 build of Node.js; ARM64 is not supported
by the native terminal package.

### pnpm install scripts

pnpm 10 and newer refuse to run dependency install scripts that were not approved. For a consumer project the runtime
one is `koffi` (a dependency of the terminal library); its script only looks for a prebuilt binary, so it may stay
disabled. In `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  koffi: false # or true; without a decision `pnpm install` stops with ERR_PNPM_IGNORED_BUILDS
```

The repository itself also approves `esbuild` and `@parcel/watcher` for development. Those are not installed as runtime
dependencies of a consumer project.

## 2. Standalone release bundle

Download `tui-grade-<version>-<platform>-<arch>.tar.gz` from the GitHub release:

```bash
tar -xzf tui-grade-1.0.0-linux-x64.tar.gz
./tui-grade/tui-grade --help

# Windows
tar -xzf tui-grade-1.0.0-win32-x64.tar.gz
tui-grade\tui-grade.cmd --help
```

The bundle contains `dist/`, the production `node_modules` and a `tui-grade` launcher. It does not need npm install,
only Node.js 26. The archive is built for the platform it was made on because `@microsoft/tui-test` has a native,
platform-specific package.

The launcher also works through a symlink:

```bash
ln -s "$PWD/tui-grade/tui-grade" ~/bin/tui-grade
```

## 3. Source checkout

Use this for development, a local build, or a version you want to modify:

```bash
git clone https://github.com/tuplle/tui-grade.git
cd tui-grade
pnpm install
pnpm build
node dist/cli/main.js --help
pnpm start       # build and start the localhost dashboard
pnpm dev         # dashboard from source, with built web assets
```

`pnpm build` compiles TypeScript to `dist/`, copies the locales and builds the browser dashboard (esbuild + Tailwind).

The CLI can also run directly from source with Node 26 type stripping:

```bash
node src/cli/main.ts --help
```

That source-only command needs dependencies installed. The web dashboard also needs generated browser assets, so run
`pnpm build` or `pnpm build:web` before `node src/cli/main.ts serve`.

## Verify the installation

```bash
tui-grade --version
tui-grade --help
tui-grade describe
```

`tui-grade describe` should list the built-in steps, checks, builders, reporters and scorers.

## Next

- [Quick start](quickstart.md)
- [CLI reference](cli.md)
- [Web UI](web-ui.md)
