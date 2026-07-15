#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  if (![
    'validate', 'scope', 'render', 'hash-file', 'bind-spec', 'start', 'next', 'record', 'verify', 'attest',
    'finish', 'status', 'resume', 'retry', 'abort', 'close'
  ].includes(command)) {
    usage(`unknown command: ${command}`);
  }
  if (command === 'scope' && tokens.length !== 1) usage('scope requires exactly one selector');
  if (command === 'hash-file' && tokens.length !== 1) usage('hash-file requires one repository-relative path');
  if (command === 'bind-spec' && tokens.length !== 2) usage('bind-spec requires one feature id and one spec path');
  if (command === 'start') {
    if (tokens.length !== 2 || !['--manifest-approved', '--sandboxed'].includes(tokens[1])) {
      usage('start requires one selector and exactly one authorization mode');
    }
  }
  if (command === 'next' && tokens.length !== 1) usage('next requires exactly one run id');
  if (command === 'record') {
    if (tokens.length < 6 || tokens[2] !== '--commit' || tokens[4] !== '--ac' || tokens.length % 2 !== 0) {
      usage('record requires run id, item id, --commit SHA, and one or more --ac IDs');
    }
    for (let index = 4; index < tokens.length; index += 2) {
      if (tokens[index] !== '--ac' || !tokens[index + 1]) usage('each record criterion requires --ac ID');
    }
  }
  if (command === 'verify' && tokens.length !== 2) usage('verify requires one run id and one item id');
  if (command === 'attest' && tokens.length !== 4) usage('attest requires run id, item id, gate, and report path');
  if (command === 'finish' && tokens.length !== 2) usage('finish requires one run id and one item id');
  if (['status', 'resume'].includes(command)
      && (tokens.length !== 1 || (tokens[0] !== '--active' && tokens[0].startsWith('--')))) {
    usage(`${command} requires one run id or --active`);
  }
  if (command === 'retry' && (tokens.length !== 4 || tokens[2] !== '--reason' || !tokens[3])) {
    usage('retry requires run id, item id, and --reason text');
  }
  if (command === 'abort' && (tokens.length !== 2 || tokens[1] !== '--confirm')) {
    usage('abort requires one run id and --confirm');
  }
  if (command === 'close'
      && (tokens.length < 1 || tokens.length > 2 || (tokens.length === 2 && tokens[1] !== '--require-success'))) {
    usage('close requires one run id and optional --require-success');
  }
  if (![
    'scope', 'hash-file', 'bind-spec', 'start', 'next', 'record', 'verify', 'attest', 'finish', 'status', 'resume', 'retry', 'abort', 'close'
  ].includes(command) && tokens.length !== 0) {
    usage(`${command} does not accept arguments`);
  }
  return {
    root,
    command,
    args: tokens,
    options: {
      manifestApproved: command === 'start' && tokens[1] === '--manifest-approved',
      sandboxed: command === 'start' && tokens[1] === '--sandboxed',
      commit: command === 'record' ? tokens[3] : null,
      acIds: command === 'record' ? tokens.slice(5).filter((_, index) => index % 2 === 0) : [],
      active: ['status', 'resume'].includes(command) && tokens[0] === '--active',
      reason: command === 'retry' ? tokens[3] : null,
      confirmed: command === 'abort' && tokens[1] === '--confirm',
      requireSuccess: command === 'close' && tokens[1] === '--require-success'
    }
  };
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const { root, command, args, options } = parseGlobalArgs(argv);
  let result;
  if (command === 'hash-file') {
    result = await RoadmapController.hashFileAtRoot(root, args[0]);
  } else if (command === 'status' && options.active) {
    const active = await RoadmapController.inspectActiveRun(root);
    if (!active.active) {
      result = {
        runId: null,
        status: 'inactive',
        selector: null,
        scope: [],
        activeItemId: null,
        remaining: [],
        blockers: {},
        action: 'none',
        item: null,
        attempt: null
      };
    } else {
      const controller = await RoadmapController.open(root);
      result = await controller.status(null);
    }
  } else {
    const controller = await RoadmapController.open(root);
    const handlers = {
      validate: () => controller.validate(),
      scope: () => controller.scope(args[0]),
      render: () => controller.render(),
      'bind-spec': () => controller.bindSpec(args[0], args[1]),
      start: () => controller.start(args[0], options),
      next: () => controller.next(args[0]),
      record: () => controller.record(args[0], args[1], options),
      verify: () => controller.verify(args[0], args[1]),
      attest: () => controller.attest(args[0], args[1], args[2], args[3]),
      finish: () => controller.finish(args[0], args[1]),
      status: () => controller.status(args[0]),
      resume: () => controller.resume(options.active ? null : args[0]),
      retry: () => controller.retry(args[0], args[1], options.reason),
      abort: () => controller.abort(args[0], options),
      close: () => controller.close(args[0], options)
    };
    result = await handlers[command]();
  }
  io.stdout.write(canonicalStringify(result));
  return EXIT_CODES.OK;
}

function normalizeError(error) {
  if (error instanceof RoadmapError) {
    if (error.code === 'USAGE') return { code: 'USAGE', exitCode: EXIT_CODES.USAGE, message: 'invalid command usage' };
    if (/CONFLICT/.test(error.code)) return { code: 'CONFLICT', exitCode: EXIT_CODES.CONFLICT, message: 'operation conflicts with existing state' };
    return { code: 'INVALID', exitCode: EXIT_CODES.INVALID, message: 'invalid roadmap input' };
  }
  return { code: 'INTERNAL', exitCode: EXIT_CODES.INTERNAL, message: 'internal error' };
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const diagnostic = normalizeError(error);
    process.stderr.write(canonicalStringify({ code: diagnostic.code, message: diagnostic.message }));
    process.exitCode = diagnostic.exitCode;
  }
}
