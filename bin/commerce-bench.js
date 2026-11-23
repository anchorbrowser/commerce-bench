#!/usr/bin/env node
process.removeAllListeners("warning");
await import("../src/cli.ts");
