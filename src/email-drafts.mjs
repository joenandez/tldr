#!/usr/bin/env node
// The email-intent draft CLI. libexec/component-dispatch runs it on the
// package's verified Node runtime: `tldr-agents drafts <verb> [args...]`.
import { main } from "./lib/email_intent_draft_cli.mjs";

process.exitCode = await main(process.argv.slice(2));
