#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { canonicalStringify } from '../src/roadmapctl/canonical-json.mjs';
import { RoadmapController } from '../src/roadmapctl/controller.mjs';
import { EXIT_CODES, RoadmapError } from '../src/roadmapctl/errors.mjs';

function usage(message) {
  throw new RoadmapError('USAGE', message);
}

export function parseGlobalArgs(argv) {
  const tokens = [...argv];
  let root = process.cwd();
  if (tokens[0] === '--root') {
    if (!tokens[1] || tokens[1].startsWith('--')) usage('--root requires a path');
    root = tokens[1];
    tokens.splice(0, 2);
  }
  if (tokens.some(token => token === '--root')) usage('--root must be the leading option');
  const command = tokens.shift();
  if (!command) usage('a command is required');
  if (!['validate', 'scope', 'render'].includes(command)) usage(`unknown command: ${command}`);
  if (command === 'scope' && tokens.length !== 1) usage('scope requires exactly one selector');
  if (command !== 'scope' && tokens.length !== 0) usage(`${command} does not accept arguments`);
  return { root, command, args: tokens };
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const { root, command, args } = parseGlobalArgs(argv);
  const controller = await RoadmapController.open(root);
  const handlers = {
    validate: () => controller.validate(),
    scope: () => controller.scope(args[0]),
    render: () => controller.render()
  };
  const result = await handlers[command]();
  io.stdout.write(canonicalStringify(result));
  return EXIT_CODES.OK;
}

function normalizeError(error) {
  if (error instanceof RoadmapError) {
    if (error.code === 'USAGE') return { code: 'USAGE', exitCode: EXIT_CODES.USAGE, message: error.message };
    if (/CONFLICT/.test(error.code)) return { code: error.code, exitCode: EXIT_CODES.CONFLICT, message: error.message };
    return { code: 'INVALID', exitCode: EXIT_CODES.INVALID, message: error.message };
  }
  return { code: 'INTERNAL', exitCode: EXIT_CODES.INTERNAL, message: 'internal error' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const diagnostic = normalizeError(error);
    process.stderr.write(canonicalStringify({ code: diagnostic.code, message: diagnostic.message }));
    process.exitCode = diagnostic.exitCode;
  }
}
