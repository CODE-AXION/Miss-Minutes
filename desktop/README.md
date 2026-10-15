# Miss Minutes (desktop)

Electron + React tray app for the meeting-notes pipeline. The installer bundles the engine (`mm-engine.exe`, built from `watcher.py` with PyInstaller) and HandBrakeCLI; developer mode runs `watcher.py serve` from the project folder instead.

**How to install and use the app, and how to uninstall it: see the [main README](../README.md).**

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# Windows installer -> dist/Miss Minutes Setup <version>.exe (per-user; bundles the engine and HandBrake)
$ npm run dist

# Same, reusing the last engine build
$ npm run dist:app
```
