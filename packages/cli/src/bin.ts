#!/usr/bin/env node
/**
 * Executable entry point of the CLI (`agent-context`).
 *
 * The shebang keeps `npx agent-context <command>` working, and the process exit
 * code mirrors the analysis result so CI can gate on `scan`/`status`.
 */
import { runCli } from './cli.ts';

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;