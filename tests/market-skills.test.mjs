import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeCountry, classifyExperience, normalizeJob, deduplicate, collect, analyze, csv, dateOnly } from '../market-skills.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/market-skills/ats.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const ctx = { fetchJson: async url => {
  assert.ok(Object.hasOwn(fixture.responses, url), `Unexpected request: ${url}`);
  return structuredClone(fixture.responses[url]);
} };
const raw = (overrides = {}) => ({ provider: 'lever', board: 'example', company: 'Example', title: 'Engineer',
  url: 'https://jobs.lever.co/example/1', externalId: '1', location: 'India', description: '3 years of experience. Python.', ...overrides });
const snapshot = await collect(fixture, ctx);

test('real providers parse synthetic payloads and deduplicate to nine jobs', () => {
  assert.equal(snapshot.jobs.length, 10);
  assert.ok(snapshot.sources.every(s => s.status === 'ok'));
  const report = analyze(snapshot, { asOf: '2026-10-26' });
  assert.deepEqual(report.totals, { observations: 10, rejected: 0, duplicatesRemoved: 1, excludedByDate: 0, jobs: 9, missingDescription: 1, undated: 2 });
  const count = (country, category) => report.jobCounts.find(r => r.country === country && r.experienceCategory === category).jobCount;
  assert.equal(count('India', 'fresher'), 2);
  assert.equal(count('India', 'experienced'), 1);
  assert.equal(count('United States', 'fresher'), 1);
  assert.equal(count('United States', 'experienced'), 1);
  assert.equal(count('United States', 'unknown'), 1);
  assert.equal(count('unknown', 'unknown'), 2);
  assert.equal(count('unknown', 'experienced'), 1);
  assert.equal(report.partial, false);
  assert.equal(report.sourceCoverage.reduce((n, s) => n + s.includedUniqueJobs, 0), 9);
});

for (const [location, expected] of [
  ['Bengaluru, India', 'India'], ['IN', 'India'], ['United States of America', 'United States'],
  ['Remote, US', 'United States'], ['USA', 'United States'], ['U.S.A.', 'United States'],
  ['India; United States', 'unknown'], ['Remote', 'unknown'], ['Cambridge', 'unknown'],
  ['London', 'unknown'], ['CA', 'unknown'], ['work in engineering with us', 'unknown'], [null, 'unknown'],
]) test(`country: ${location}`, () => assert.equal(normalizeCountry(location), expected));

for (const [text, category, minYears] of [
  ['0-2 years of experience', 'fresher', 0], ['3+ years of experience', 'experienced', 3],
  ['2 to 5 years relevant experience', 'experienced', 2], ['6 months of experience', 'experienced', 0.5],
  ['1.5 years of experience', 'experienced', 1.5], ['No prior experience required', 'fresher', 0],
  ['Freshers welcome', 'fresher', 0], ['2 years of experience preferred', 'unknown', null],
  ['Our company is 20 years old. SQL.', 'unknown', null], ['Junior graduate engineer', 'unknown', null],
  ['up to 2 years of experience', 'unknown', null], ['5-2 years of experience', 'unknown', null],
  ['No experience required. 5 years of experience required.', 'unknown', null],
  ['3 years of experience required. 5 years of experience preferred.', 'experienced', 3],
]) test(`experience: ${text}`, () => {
  const result = classifyExperience(text);
  assert.equal(result.category, category); assert.equal(result.minYears, minYears);
});

test('skills use shared aliases and count each skill once per posting', () => {
  const a = normalizeJob(raw({ description: 'Python Python PostgreSQL Postgres Amazon Web Services AWS' }));
  assert.equal(a.extractedSkills.filter(x => x === 'Python').length, 1);
  assert.equal(a.extractedSkills.filter(x => /postgres/i.test(x)).length, 1);
  assert.equal(a.extractedSkills.filter(x => x === 'AWS').length, 1);
  const report = analyze(snapshot, { asOf: '2026-10-26' });
  const skill = report.skillFrequencies.find(s => s.country === 'India' && s.experienceCategory === 'fresher' && s.skill === 'Python');
  assert.equal(skill.jobCount, 2); assert.equal(skill.percentageOfJobs, 100);
});

test('stable IDs are scoped by provider and board; URL aliases merge transitively', () => {
  const jobs = [normalizeJob(raw()), normalizeJob(raw({ url: 'https://example.com/jobs/alias' })),
    normalizeJob(raw({ externalId: null, url: 'https://example.com/jobs/alias?utm_source=test#apply' }))];
  assert.equal(deduplicate(jobs).length, 1);
  assert.deepEqual(deduplicate(jobs), deduplicate([...jobs].reverse()));
  assert.equal(deduplicate([jobs[0], normalizeJob(raw({ board: 'other', url: 'https://jobs.lever.co/other/1' }))]).length, 2);
  assert.equal(deduplicate([normalizeJob(raw({ externalId: null, url: 'https://example.com/?job=1' })), normalizeJob(raw({ externalId: null, url: 'https://example.com/?job=2' }))]).length, 2);
});

test('conflicting duplicate geography and experience stay unknown', () => {
  const [job] = deduplicate([normalizeJob(raw()), normalizeJob(raw({ location: 'United States', description: 'No experience required. Python.' }))]);
  assert.equal(job.country, 'unknown'); assert.equal(job.experienceCategory, 'unknown');
});

test('date window is inclusive UTC; unknown dates excluded only with a window', () => {
  const report = analyze(snapshot, { asOf: '2026-10-26', from: '2026-10-20', to: '2026-10-24' });
  assert.equal(report.totals.jobs, 6); assert.equal(report.totals.excludedByDate, 3);
  assert.equal(normalizeJob(raw({ postedAt: '2026-02-30' })).postingDate, null);
  assert.equal(normalizeJob(raw({ postedAt: 0 })).postingDate, '1970-01-01T00:00:00.000Z');
  assert.throws(() => dateOnly('2026-02-30'));
  assert.throws(() => analyze(snapshot, { asOf: '2026-10-26', from: '2026-10-24', to: '2026-10-20' }));
});

test('provider failures remain visible; malformed jobs are rejected', async () => {
  const broken = await collect({ boards: [fixture.boards[0]] }, { fetchJson: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
  assert.equal(broken.sources[0].status, 'error');
  assert.equal(analyze(broken, { asOf: '2026-10-26' }).partial, true);
  const bad = analyze({ ...snapshot, jobs: [...snapshot.jobs, null, raw({ url: 'javascript:alert(1)' }), raw({ title: '' })] }, { asOf: '2026-10-26' });
  assert.equal(bad.totals.rejected, 3); assert.equal(bad.partial, true);
  await assert.rejects(collect({ boards: [{ provider: 'linkedin', name: 'No', board: 'no' }] }, ctx));
  await assert.rejects(collect({ boards: [fixture.boards[0], fixture.boards[0]] }, ctx));
});

test('CSV quotes commas/newlines and neutralizes spreadsheet formulas', () => {
  assert.equal(csv([{ text: 'a,"b"\nc', danger: '=1+1' }], ['text', 'danger']), '"text","danger"\r\n"a,""b""\nc","\'=1+1"\r\n');
});

test('CLI fixture collection and snapshot replay produce byte-identical reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-skills-test-'));
  try {
    const script = fileURLToPath(new URL('../market-skills.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const first = run(['--fixtures', fixturePath, '--as-of', '2026-10-26', '--out', join(dir, 'first')]);
    assert.equal(first.status, 0, first.stderr);
    const second = run(['--input', join(dir, 'first', 'snapshot.json'), '--as-of', '2026-10-26', '--out', join(dir, 'second')]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readdirSync(join(dir, 'first')).length, 6);
    for (const file of readdirSync(join(dir, 'first'))) assert.deepEqual(readFileSync(join(dir, 'first', file)), readFileSync(join(dir, 'second', file)), file);
    assert.notEqual(run(['--fixtures', fixturePath, '--as-of', 'bad']).status, 0);
    assert.notEqual(run(['--fixtures', fixturePath, '--as-of', '2026-10-26', '--invalid']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mixed target and foreign countries are conservative', () => {
  assert.equal(normalizeCountry('India; Canada'), 'unknown');
  assert.equal(normalizeCountry('United States; United Kingdom'), 'unknown');
  assert.equal(normalizeCountry('Indiana'), 'unknown');
});

test('malformed success payload is an error rather than a zero-job market', async () => {
  const result = await collect({ boards: [fixture.boards[0]] }, { fetchJson: async () => ({ error: 'blocked' }) });
  assert.equal(result.sources[0].status, 'error');
  assert.equal(result.sources[0].error, 'Unexpected ATS response shape');
});

test('a genuine empty board reports success and zero counts', async () => {
  const result = await collect({ boards: [fixture.boards[0]] }, { fetchJson: async () => ({ jobs: [] }) });
  const report = analyze(result, { asOf: '2026-10-26' });
  assert.equal(report.partial, false); assert.equal(report.totals.jobs, 0);
  assert.equal(report.jobCounts.length, 9); assert.equal(report.skillFrequencies.length, 0);
});

test('source coverage schema is validated', () => {
  assert.throws(() => analyze({ ...snapshot, sources: [{}] }, { asOf: '2026-10-26' }));
  const report = analyze({ ...snapshot, sources: [] }, { asOf: '2026-10-26' });
  assert.equal(report.totals.rejected, 10); assert.equal(report.partial, true);
});

test('labeled experience requirements and explicit experience waiver', () => {
  assert.equal(classifyExperience('Experience: 3+ years').category, 'experienced');
  assert.equal(classifyExperience('Experience: 0-2 years').category, 'fresher');
  assert.equal(classifyExperience('Experience is not required').category, 'fresher');
  assert.equal(classifyExperience('3 years of experience not required').category, 'unknown');
});

test('CLI respects the user data root and reports partial failure via exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-skills-root-'));
  try {
    const script = fileURLToPath(new URL('../market-skills.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--fixtures', fixturePath, '--as-of', '2026-10-26'], {
      encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, join(dir, 'reports', 'market-skills', '2026-10-26'));
    const report = JSON.parse(readFileSync(join(dir, 'reports', 'market-skills', '2026-10-26', 'report.json')));
    assert.equal(report.totals.jobs, 9);
    const brokenFile = join(dir, 'broken.json');
    writeFileSync(brokenFile, JSON.stringify({ schemaVersion: 1, jobs: [], sources: [{ provider: 'lever', board: 'broken', status: 'error', fetched: 0, error: 'test failure' }] }));
    const broken = spawnSync(process.execPath, [script, '--input', brokenFile, '--as-of', '2026-10-26', '--out', join(dir, 'partial')], { encoding: 'utf8' });
    assert.equal(broken.status, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, 'partial', 'report.json'))).partial, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
