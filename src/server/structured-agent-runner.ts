#!/usr/bin/env bun

import { runStructuredAgentCommand } from "./agent-tools/run-structured-agent-command"

await runStructuredAgentCommand(process.argv.slice(2))
