#!/usr/bin/env node
/** Aggregate public ATS observations without touching the personal pipeline. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { extractSkills } from './skill-extract.mjs';
import { normalizeUrl } from './url-key.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

export const PROVIDERS = { greenhouse, lever, ashby };
const otherCountries = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const foreignNames = [];
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b);
  if (code === 'IN' || code === 'US') continue;
  const name = otherCountries.of(code);
  if (name) foreignNames.push(name.toLowerCase());
}
const countries = ['India', 'United States', 'unknown'];
const categories = ['fresher', 'experienced', 'unknown'];
const str = value => typeof value === 'string' ? value.trim() : '';
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)].sort(cmp);

export function normalizeCountry(location) {
  const s = str(location);
  // Explicit country labels only. Cities, state abbreviations and "remote"
  // intentionally carry no country inference. Case-sensitive ISO tokens avoid
  // interpreting the preposition "in" or pronoun "us" as countries.
  const india = /\bIndia\b/i.test(s) || /(?:^|[,;|(/]\s*)IN(?=$|[\s,;|)/])/.test(s);
  const us = /\bUnited States(?: of America)?\b|\bUSA\b|\bU\.S\.(?:A\.)?/i.test(s)
    || /(?:^|[,;|(/]\s*)US(?=$|[\s,;|)/])/.test(s);
  const lower = s.toLowerCase();
  const foreign = foreignNames.some(name => {
    const at = lower.indexOf(name);
    return at >= 0 && !/[a-z]/.test(lower[at - 1] || '') && !/[a-z]/.test(lower[at + name.length] || '');
  });
  return foreign || india === us ? 'unknown' : india ? 'India' : 'United States';
}

export function classifyExperience(description) {
  const evidence = [];
  const minimums = [];
  let zero = false;
  // Do not infer experience from junior/senior titles or years unrelated to
  // experience (company age, degree duration). Preferred years are not gates.
  for (const sentence of str(description).split(/\n+|(?<!\d)[.;!?]+|[.;!?]+(?!\d)/)) {
    if (/\b(preferred|desirable|nice.to.have|bonus)\b/i.test(sentence)) continue;
    if (/^\s*(?:prior |previous |work )?experience (?:is )?not required\b/i.test(sentence)) {
      zero = true; evidence.push(sentence.trim()); continue;
    }
    if (/\bnot required\b/i.test(sentence)) continue;
    if (/\b(no (?:prior |previous |professional |work )?experience (?:is )?(?:required|necessary)|freshers? (?:are )?(?:welcome|eligible)|(?:new|recent) graduates? (?:are )?(?:welcome|eligible))\b/i.test(sentence)) {
      zero = true; evidence.push(sentence.trim());
    }
    const labeled = sentence.match(/\b(?:required |minimum )?experience\s*:\s*(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*\+?\s*(years?|yrs?|months?)\b/i);
    if (labeled && (labeled[2] === undefined || Number(labeled[2]) >= Number(labeled[1]))) {
      minimums.push(Number(labeled[1]) / (/month/i.test(labeled[3]) ? 12 : 1));
      evidence.push(sentence.trim());
    }
    const re = /\b(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*\+?\s*(years?|yrs?|months?)\s*(?:of\s+)?(?:(?:relevant|professional|work|industry|hands-on)\s+)?experience\b/gi;
    for (const m of sentence.matchAll(re)) {
      const low = Number(m[1]), high = m[2] === undefined ? null : Number(m[2]);
      if (high !== null && high < low) continue;
      // "up to" is a ceiling, not evidence of a minimum.
      if (/\b(up to|at most|less than)\s*$/i.test(sentence.slice(0, m.index))) continue;
      minimums.push(low / (/month/i.test(m[3]) ? 12 : 1));
      evidence.push(sentence.trim());
    }
  }
  const minYears = minimums.length ? Math.max(...minimums) : zero ? 0 : null;
  const conflicting = zero && minYears > 0;
  return {
    category: conflicting || minYears === null ? 'unknown' : minYears === 0 ? 'fresher' : 'experienced',
    minYears: conflicting ? null : minYears,
    evidence: unique(evidence),
    reason: conflicting ? 'conflicting requirements' : minYears === null ? 'no explicit minimum' : 'explicit experience evidence',
  };
}

export function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must be YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
  return value;
}

function postingDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
    try { dateOnly(value.slice(0, 10)); } catch { return null; }
  } else if (typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Listing must be an object');
  const source = str(raw.provider);
  if (!Object.hasOwn(PROVIDERS, source)) throw new Error('Unsupported provider');
  const sourceUrl = normalizeUrl(raw.url);
  if (!sourceUrl || new URL(sourceUrl).username || new URL(sourceUrl).password) throw new Error('Listing requires an HTTP(S) URL without credentials');
  if (!str(raw.title) || !str(raw.company)) throw new Error('Listing requires title and company');
  const board = str(raw.board);
  if (!board) throw new Error('Listing requires board scope');
  const id = raw.listingIdentity?.posting_id ?? raw.externalId;
  const postingId = typeof id === 'string' && id.trim() ? id.trim()
    : typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : null;
  const identityKey = postingId ? JSON.stringify([source, board, postingId]) : null;
  const description = str(raw.description);
  const experienceRequirement = classifyExperience(description);
  const seniorityCategory = /\b(senior|sr\.?|lead|principal|staff)\b/i.test(raw.title) ? 'senior'
    : /\b(junior|jr\.?|entry.level|intern|graduate)\b/i.test(raw.title) ? 'entry' : 'unknown';
  return {
    jobId: hash(identityKey || sourceUrl), postingId, identityKey,
    company: raw.company.trim(), jobTitle: raw.title.trim(), sourceUrl,
    source, board, location: str(raw.location), country: normalizeCountry(raw.location),
    experienceRequirement, experienceCategory: experienceRequirement.category,
    seniorityCategory, postingDate: postingDate(raw.postedAt), description,
    extractedSkills: unique([...extractSkills(description)]),
    sources: [JSON.stringify([source, board])],
  };
}

export function deduplicate(jobs) {
  // Connected components preserve aliases: A(id1,url1), B(id1,url2),
  // C(no-id,url2) must be one posting even if C appears first.
  const parents = jobs.map((_, i) => i);
  const root = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const keys = new Map();
  jobs.forEach((job, i) => {
    for (const key of ['url:' + job.sourceUrl, ...(job.identityKey ? ['id:' + job.identityKey] : [])]) {
      if (keys.has(key)) parents[root(i)] = root(keys.get(key));
      else keys.set(key, i);
    }
  });
  const groups = new Map();
  jobs.forEach((job, i) => { const key = root(i); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(job); });
  return [...groups.values()].map(group => {
    group.sort((a, b) => b.description.length - a.description.length || cmp(JSON.stringify(a), JSON.stringify(b)));
    const selected = { ...group[0] };
    selected.jobId = hash(unique(group.map(j => j.identityKey).filter(Boolean))[0] || unique(group.map(j => j.sourceUrl))[0]);
    selected.sources = unique(group.flatMap(j => j.sources));
    selected.extractedSkills = unique(group.flatMap(j => j.extractedSkills));
    selected.duplicateObservations = group.length - 1;
    const knownCountries = unique(group.map(j => j.country).filter(c => c !== 'unknown'));
    selected.country = knownCountries.length === 1 ? knownCountries[0] : 'unknown';
    const knownExperience = unique(group.map(j => j.experienceCategory).filter(c => c !== 'unknown'));
    if (knownExperience.length > 1) {
      selected.experienceCategory = 'unknown';
      selected.experienceRequirement = { category: 'unknown', minYears: null,
        evidence: unique(group.flatMap(j => j.experienceRequirement.evidence)), reason: 'conflicting duplicate observations' };
    }
    return selected;
  }).sort((a, b) => cmp(a.jobId, b.jobId));
}

export async function collect(config, ctx = makeHttpCtx()) {
  if (!Array.isArray(config.boards) || config.boards.length === 0) throw new Error('Config requires a nonempty boards array');
  const seen = new Set();
  const boards = config.boards.map(entry => {
    if (!entry || !Object.hasOwn(PROVIDERS, entry.provider) || !str(entry.name) || !str(entry.board)) throw new Error('Each board requires supported provider, name and board slug');
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.board)) throw new Error('Invalid board slug');
    const key = JSON.stringify([entry.provider, entry.board]);
    if (seen.has(key)) throw new Error('Duplicate board configuration');
    seen.add(key);
    // Construct only recognized public endpoints. Ignore arbitrary API URLs,
    // plugins, executable parsers and embed fallbacks in supplied config.
    const urls = { greenhouse: 'https://boards.greenhouse.io/', lever: 'https://jobs.lever.co/', ashby: 'https://jobs.ashbyhq.com/' };
    return { ...entry, careers_url: urls[entry.provider] + entry.board };
  });
  const jobs = [], sources = [];
  for (const entry of boards) {
    const coverage = { provider: entry.provider, board: entry.board, company: entry.name, status: 'ok', fetched: 0, error: null };
    try {
      const checkedCtx = { ...ctx, fetchJson: async (url, options) => {
        const payload = await ctx.fetchJson(url, options);
        const valid = /\/offices(?:\?|$)/.test(url) ? Array.isArray(payload?.offices)
          : entry.provider === 'lever' ? Array.isArray(payload) : Array.isArray(payload?.jobs);
        if (!valid) throw new Error('Unexpected ATS response shape');
        return payload;
      } };
      const rows = await PROVIDERS[entry.provider].fetch({ name: entry.name, careers_url: entry.careers_url }, checkedCtx);
      if (!Array.isArray(rows)) throw new Error('Provider did not return a listing array');
      coverage.fetched = rows.length;
      jobs.push(...rows.map(row => ({ ...row, provider: entry.provider, board: entry.board })));
    } catch (error) {
      coverage.status = 'error';
      coverage.error = String(error?.message || error);
    }
    sources.push(coverage);
  }
  return { schemaVersion: 1, jobs, sources };
}

export function analyze(snapshot, { asOf, from = null, to = null } = {}) {
  dateOnly(asOf);
  if (from) dateOnly(from);
  if (to) dateOnly(to);
  if (from && to && from > to) throw new Error('from must not be after to');
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.sources)) throw new Error('Expected schemaVersion 1 snapshot with jobs and sources arrays');
  const sourceKeys = new Set();
  for (const source of snapshot.sources) {
    if (!source || !Object.hasOwn(PROVIDERS, source.provider) || !str(source.board)
      || !['ok', 'error'].includes(source.status) || !Number.isSafeInteger(source.fetched) || source.fetched < 0) {
      throw new Error('Invalid source coverage row');
    }
    const key = JSON.stringify([source.provider, source.board]);
    if (sourceKeys.has(key)) throw new Error('Duplicate source coverage row');
    sourceKeys.add(key);
  }
  const rejected = [], normalized = [];
  snapshot.jobs.forEach((raw, index) => {
    try {
      const job = normalizeJob(raw);
      if (!sourceKeys.has(job.sources[0])) throw new Error('Listing has no source coverage row');
      normalized.push(job);
    } catch (e) { rejected.push({ index, reason: e.message }); }
  });
  const all = deduplicate(normalized);
  const jobs = all.filter(j => {
    const day = j.postingDate?.slice(0, 10);
    return (!from && !to) || (day && (!from || day >= from) && (!to || day <= to));
  });
  const jobCounts = [], skillFrequencies = [];
  for (const country of countries) for (const experienceCategory of categories) {
    const segment = jobs.filter(j => j.country === country && j.experienceCategory === experienceCategory);
    jobCounts.push({ country, experienceCategory, jobCount: segment.length });
    const counts = new Map();
    for (const job of segment) for (const skill of job.extractedSkills) counts.set(skill, (counts.get(skill) || 0) + 1);
    for (const [skill, jobCount] of [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))) {
      skillFrequencies.push({ country, experienceCategory, skill, jobCount,
        percentageOfJobs: Number((100 * jobCount / segment.length).toFixed(2)) });
    }
  }
  const sourceCoverage = snapshot.sources.map(source => ({ ...source,
    includedUniqueJobs: jobs.filter(j => j.sources.includes(JSON.stringify([source.provider, source.board]))).length,
  })).sort((a, b) => cmp(JSON.stringify([a.provider, a.board]), JSON.stringify([b.provider, b.board])));
  return { schemaVersion: 1, asOf, window: { from, to, undated: from || to ? 'excluded' : 'included' },
    inputSha256: hash(JSON.stringify(snapshot)),
    totals: { observations: snapshot.jobs.length, rejected: rejected.length, duplicatesRemoved: normalized.length - all.length,
      excludedByDate: all.length - jobs.length, jobs: jobs.length,
      missingDescription: jobs.filter(j => !j.description).length,
      undated: jobs.filter(j => !j.postingDate).length },
    partial: rejected.length > 0 || sourceCoverage.some(s => s.status !== 'ok'),
    jobCounts, skillFrequencies, sourceCoverage, rejected, jobs };
}

export function csv(rows, columns) {
  const cell = value => {
    let text = Array.isArray(value) ? value.join('; ') : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Preserve JSON verbatim; prevent spreadsheet formula execution in CSV.
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function exportReport(report, snapshot, directory) {
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of [['report', report], ['snapshot', snapshot]]) writeFileSync(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  const dated = rows => rows.map(row => ({ asOf: report.asOf, from: report.window.from, to: report.window.to, ...row }));
  const tables = [
    ['job-counts', report.jobCounts, ['country', 'experienceCategory', 'jobCount']],
    ['skills', report.skillFrequencies, ['country', 'experienceCategory', 'skill', 'jobCount', 'percentageOfJobs']],
    ['sources', report.sourceCoverage, ['provider', 'board', 'company', 'status', 'fetched', 'includedUniqueJobs', 'error']],
    ['jobs', report.jobs, ['jobId', 'postingId', 'company', 'jobTitle', 'sourceUrl', 'source', 'board', 'location', 'country', 'experienceCategory', 'experienceRequirement', 'seniorityCategory', 'postingDate', 'description', 'extractedSkills']],
  ];
  for (const [name, rows, columns] of tables) writeFileSync(join(directory, name + '.csv'), csv(dated(rows), ['asOf', 'from', 'to', ...columns]));
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string' }, config: { type: 'string' }, fixtures: { type: 'string' },
    out: { type: 'string' }, 'as-of': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node market-skills.mjs (--input snapshot.json | --config boards.json | --fixtures fixture.json) --as-of YYYY-MM-DD [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out directory]');
    return;
  }
  if (['input', 'config', 'fixtures'].filter(k => values[k]).length !== 1) throw new Error('Choose exactly one of --input, --config, --fixtures');
  dateOnly(values['as-of']);
  if (values.from) dateOnly(values.from);
  if (values.to) dateOnly(values.to);
  if (values.from && values.to && values.from > values.to) throw new Error('from must not be after to');
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  let snapshot;
  if (values.input) snapshot = read(values.input);
  else if (values.fixtures) {
    const fixture = read(values.fixtures);
    const ctx = { fetchJson: async url => {
      if (!Object.hasOwn(fixture.responses, url)) throw new Error('No fixture response for ' + url);
      return structuredClone(fixture.responses[url]);
    } };
    snapshot = await collect(fixture, ctx);
    snapshot.mode = 'synthetic-fixtures';
  } else {
    snapshot = await collect(read(values.config));
    snapshot.mode = 'public-ats';
  }
  const report = analyze(snapshot, { asOf: values['as-of'], from: values.from, to: values.to });
  const out = values.out ? resolve(values.out) : join(getCareerOpsRoot(), 'reports', 'market-skills', values['as-of']);
  exportReport(report, snapshot, out);
  console.log(JSON.stringify({ output: out, ...report.totals, partial: report.partial }));
  if (report.partial) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
