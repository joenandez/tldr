#!/usr/bin/env node
// The read-only cold capability probe. libexec/component-dispatch runs it on
// the package's verified Node runtime for `tldr-agents status` before any
// lifecycle release is active; stdout carries the status JSON.
import { probeColdCapabilities } from "./lib/tldr_capability_readers.mjs";

process.stdout.write(`${JSON.stringify(await probeColdCapabilities())}\n`);
