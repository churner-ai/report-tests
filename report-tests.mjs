#!/usr/bin/env node
/**
 * report-tests — post ONE test run's per-requirement results to Churner.
 *
 * The body of `churner-ai/report-tests@v1`.
 *
 * ## Why a node20 action rather than a composite shell one
 *
 * Its sibling `report-preview` is shell, and rightly: it posts fields. This
 * one PARSES a report, and JUnit XML or vitest JSON parsing in sed/awk would
 * be a second parser to maintain and a class of quoting bugs to discover
 * inside a customer's pipeline. Node is guaranteed on every Actions runner —
 * including container jobs, where the runner injects its own — so the
 * runtime costs nothing, and the parser becomes directly testable by
 * spawning this file.
 *
 * Zero dependencies: node builtins and the global `fetch` only. An action
 * that needed `npm install` would need a build step and a committed
 * `node_modules`, which is how published actions rot.
 *
 * ## What it guarantees
 *
 *  - Exit 0 on 2xx.
 *  - Exit 1 on 400 / 401 / 403 / 413 WITHOUT retrying, printing the
 *    response body. Retrying a malformed body, a bad token or an oversize
 *    payload changes nothing, and the body is the only thing that says
 *    which refusal it was (413 is the exception — it comes from the body
 *    parser and carries no detail, so this action prints the size itself).
 *  - Retry on 429 / 5xx / network failure with bounded backoff, honouring
 *    `Retry-After`. Churner's failed-token budget refills at 1/s.
 *  - The token never reaches stdout or stderr on any path. It is a
 *    repository secret; GitHub's log masking is a backstop, not a licence.
 *  - A missing or unparseable report is a LOUD failure, never an empty run
 *    — an empty run reads downstream as "every test vanished", which would
 *    take every requirement in the project to `untested`.
 */

import { readFileSync } from 'node:fs';

/** GitHub passes `with:` inputs as `INPUT_<NAME>`, upper-cased with spaces
 *  and dashes replaced. Read here rather than shelled in, so the token is
 *  never an argv entry `ps` can show to another job on a shared runner. */
function input(name) {
  const key = `INPUT_${name.toUpperCase().replace(/[ -]/g, '_')}`;
  return (process.env[key] ?? '').trim();
}

function die(message) {
  console.error(`report-tests: ${message}`);
  process.exit(1);
}

const TRACKER_URL = input('tracker-url') || 'https://churner.ai';
const TOKEN = input('token');
const PROJECT = input('project');
const SHA = input('sha');
const ENVIRONMENT = input('environment') || 'ci';
const REPORT = input('report');
const FORMAT = input('format') || 'auto';
const PR = input('pr');
const REPORT_URL = input('report-url');
const MAX_ATTEMPTS = Number(input('max-attempts') || '5');
const BACKOFF_BASE_SECONDS = Number(input('backoff-seconds') || '1');

/** Ceiling on any single wait. A server (or something impersonating one) can
 *  answer `Retry-After: 604800`; honouring it verbatim hangs the job for a
 *  week against a step timeout nobody set. */
const MAX_DELAY_SECONDS = 60;

if (!TOKEN) die("input 'token' is required (the project's preview token)");
if (!PROJECT) die("input 'project' is required (the Churner project key, e.g. MC)");
if (!SHA) die("input 'sha' is required (the commit the run tested)");
// Refused HERE, before a request is ever sent — a malformed sha is a
// workflow-authoring mistake (the wrong context, a truncated interpolation,
// a branch name where a commit belongs) that a retry cannot fix, and the
// tracker would refuse it anyway. Checked locally so the failure names the
// input, not a 400 body the caller has to cross-reference.
if (!/^[0-9a-f]{7,40}$/.test(SHA)) {
  die(`input 'sha' must be 7-40 lowercase hex characters (got '${SHA}') — `
    + 'pass the commit\'s short or full hex sha (e.g. the pull_request event\'s head.sha), not a branch, tag or the merge ref');
}
if (!REPORT) die("input 'report' is required (path to a JUnit XML or vitest JSON report)");
// The key is interpolated into the URL PATH. Constraining it to the shape a
// key actually has refuses a traversal outright rather than encoding one
// into a 404.
if (!/^[A-Za-z0-9_-]+$/.test(PROJECT)) die(`input 'project' must be a project key of letters, digits, '-' or '_' (got '${PROJECT}')`);
if (!Number.isSafeInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS < 1) die("input 'max-attempts' must be a positive integer");
if (!Number.isSafeInteger(BACKOFF_BASE_SECONDS) || BACKOFF_BASE_SECONDS < 0) die("input 'backoff-seconds' must be a non-negative integer");

// The token rides in a header on every request, so plaintext hands it to
// anything on the path. Loopback is the one exception: it is how this file
// is tested, and there is no network to intercept.
{
  let host = null;
  if (TRACKER_URL.startsWith('https://')) host = 'ok';
  else if (TRACKER_URL.startsWith('http://')) {
    try { host = new URL(TRACKER_URL).hostname; } catch { host = null; }
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      die(`tracker-url must use https (got '${TRACKER_URL}') — the preview token rides on every request`);
    }
  } else {
    die(`tracker-url must be an http(s) URL (got '${TRACKER_URL}')`);
  }
}

let raw;
try {
  raw = readFileSync(REPORT, 'utf-8');
} catch (err) {
  die(`could not read the report at '${REPORT}': ${err instanceof Error ? err.message : 'unknown error'}`);
}

/** Decode the five XML entities a JUnit writer emits. Deliberately not a
 *  general entity table: anything else in a test title is already literal,
 *  and inventing decodings would corrupt titles that contain an ampersand. */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Blank every `<![CDATA[ ... ]]>` PAYLOAD across the WHOLE document, before
 *  either the testcase-boundary regex or the raw `<testcase` count runs —
 *  not per already-captured body, and not just for the failure/skip scan.
 *  Writers commonly wrap captured `<system-out>`/`<system-err>` in CDATA,
 *  and a passing test's own stdout can legitimately contain literal
 *  JUnit-shaped text — another tool's `<testcase>...</testcase>` echoed
 *  verbatim, a snapshot of an error page, a printed stack trace. Stripping
 *  CDATA only from a body AFTER the boundary regex has already run is too
 *  late: a `</testcase>` sitting inside CDATA closes the ELEMENT match
 *  early (the non-greedy body scan stops at that first, fake, close), so
 *  whatever comes after it — including a genuine `<failure>` — is never
 *  scanned, and a real failure is reported as a pass; a `<testcase` inside
 *  CDATA is also counted by the raw-count guard below, which then refuses
 *  a perfectly well-formed report as "under-reported" because the counts
 *  can never agree. Blanking the WHOLE document first (to an
 *  equal-length run of spaces, so nothing about surrounding structure or
 *  position shifts) removes both problems at their source: the
 *  boundary regex and the count guard both run against text that no
 *  longer contains any CDATA-quoted JUnit lookalikes, and a genuine
 *  `<failure>` element — which always sits OUTSIDE `<system-out>`'s CDATA
 *  on every mainstream writer (surefire, vitest, jest-junit, pytest) —
 *  is untouched by the blanking and still scanned normally. That
 *  "`<failure>` is never itself CDATA-escaped" assumption is the one
 *  accepted, deliberate under-verification left: a writer that nested a
 *  REAL failure element inside CDATA instead of as a sibling XML node
 *  would not be caught, but no writer does this. */
function blankCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner) => `<![CDATA[${' '.repeat(inner.length)}]]>`);
}

/**
 * JUnit XML → the wire shape.
 *
 * Regex rather than an XML parser because the shape consumed is exactly two
 * elements deep and pulling a parser in would reintroduce the dependency
 * this action exists without. `classname` is preferred over the enclosing
 * suite name because every mainstream writer puts the FILE there, and the
 * file is half the test's identity.
 *
 * The attribute scan is QUOTE-AWARE (`"[^"]*"|'[^']*'|[^>]`, tried in that
 * order at each position): a bare `[^>]*?` reads a `>` inside a quoted
 * attribute value (`name="a > b"`) as the end of the opening tag, which
 * truncates the attribute list and can drop the `name` match entirely —
 * silently discarding the whole test case. Belt-and-suspenders: the raw
 * text's own `<testcase` count is compared against how many cases this
 * function actually produced, and a mismatch dies loudly rather than
 * reporting an incomplete run as if it were the whole one — the same
 * "loud, never empty" posture as the missing-report and zero-tests checks
 * above.
 *
 * Both the boundary regex and the count run against `blankCdata(xml)`,
 * not the raw text — see that function's own comment for why doing this
 * per-body, after the boundary regex has already located each element,
 * is too late.
 */
function parseJunit(xml) {
  const out = [];
  const scrubbed = blankCdata(xml);
  const attr = '(?:"[^"]*"|\'[^\']*\'|[^>])*?';
  const caseRe = new RegExp(`<testcase\\b(${attr})(/>|>([\\s\\S]*?)</testcase>)`, 'g');
  let m = caseRe.exec(scrubbed);
  while (m !== null) {
    const attrs = m[1];
    const body = m[3] ?? '';
    const nameMatch = /\bname\s*=\s*"([^"]*)"/.exec(attrs);
    const classMatch = /\bclassname\s*=\s*"([^"]*)"/.exec(attrs);
    const fileMatch = /\bfile\s*=\s*"([^"]*)"/.exec(attrs);
    if (nameMatch !== null) {
      const name = unescapeXml(nameMatch[1]);
      const file = unescapeXml(fileMatch?.[1] ?? classMatch?.[1] ?? '');
      let status = 'passed';
      if (/<(failure|error)\b/.test(body)) status = 'failed';
      else if (/<skipped\b/.test(body)) status = 'skipped';
      out.push({ id: file ? `${file}::${name}` : name, name, status });
    }
    m = caseRe.exec(scrubbed);
  }
  const rawCount = (scrubbed.match(/<testcase\b/g) ?? []).length;
  if (out.length !== rawCount) {
    die(
      `the junit report at '${REPORT}' has ${rawCount} <testcase> element(s) but only ${out.length} parsed — `
      + `a malformed or unrecognised attribute shape dropped one silently, which would report an incomplete run as complete`,
    );
  }
  return out;
}

/**
 * Vitest / Jest JSON → the wire shape.
 *
 * `pending` and `todo` both mean skipped; anything that is not `passed` and
 * not a skip is a failure. Reading an unknown status as passed would be the
 * dangerous direction — a runner that grew a new terminal state would
 * silently verify requirements nobody proved.
 */
function parseVitestJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) {
    die(`the report at '${REPORT}' is not valid JSON: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  const files = Array.isArray(doc.testResults) ? doc.testResults : [];
  const out = [];
  for (const file of files) {
    const path = typeof file.name === 'string' ? file.name : '';
    const cases = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const c of cases) {
      const name = typeof c.fullName === 'string' && c.fullName.length > 0
        ? c.fullName
        : String(c.title ?? '');
      if (name.length === 0) continue;
      const s = String(c.status ?? '');
      const status = s === 'passed' ? 'passed' : (s === 'pending' || s === 'skipped' || s === 'todo') ? 'skipped' : 'failed';
      out.push({ id: path ? `${path}::${name}` : name, name, status });
    }
  }
  return out;
}

const format = FORMAT !== 'auto'
  ? FORMAT
  : (REPORT.toLowerCase().endsWith('.json') ? 'vitest-json' : 'junit');
if (format !== 'junit' && format !== 'vitest-json') {
  die(`input 'format' must be 'junit', 'vitest-json' or 'auto' (got '${FORMAT}')`);
}

/** Mirrors the tracker's own bounds, which live in ONE place —
 *  `shared/requirements/report-limits.ts` in the churner monorepo, read by
 *  `server/src/routes/requirement-results.ts`. Mirrored as literals rather
 *  than imported because this action is deliberately dependency-free and
 *  published as three standalone files; `server/tests/report-tests-action.test.ts`
 *  asserts these two numbers still equal the shared ones, so the copy
 *  cannot drift silently.
 *
 *  Both are checked HERE as well as at the route, and the two refusals say
 *  different things. Locally, the failure names the actual count or size
 *  and the fix. From the route, a body over the ceiling is refused by the
 *  PARSER — an HTTP 413 whose envelope cannot explain itself against a
 *  report the caller cannot see from the log alone. */
const MAX_TESTS = 5000;
const BYTES_PER_TEST = 320;
const MAX_BODY_BYTES = MAX_TESTS * BYTES_PER_TEST;

const tests = format === 'junit' ? parseJunit(raw) : parseVitestJson(raw);
if (tests.length === 0) {
  // Loud, not empty. An empty run would take every requirement in the
  // project to `untested` on the next read.
  die(`the ${format} report at '${REPORT}' contained no test cases — refusing to report an empty run`);
}
if (tests.length > MAX_TESTS) {
  die(`the ${format} report at '${REPORT}' has ${tests.length} test cases, over the ${MAX_TESTS} the tracker accepts per run — `
    + 'split the report (e.g. shard the test run and report each shard separately) or filter it down before reporting');
}

const body = { sha: SHA, environment: ENVIRONMENT, tests };
if (PR) {
  // The route accepts a numeric string (a workflow interpolates
  // `${{ github.event.pull_request.number }}` as text), but sends the
  // cleaner shape when the input parses as one — an integer, not its
  // string spelling.
  const n = Number(PR);
  body.pr = Number.isSafeInteger(n) ? n : PR;
}
if (REPORT_URL) body.reportUrl = REPORT_URL;

// Measured on the EXACT bytes that will be sent, after the body is
// assembled — a per-test estimate would be a second, disagreeing
// arithmetic, and the count check above already passed for a report whose
// titles are long enough to blow the ceiling anyway.
const payload = JSON.stringify(body);
const payloadBytes = Buffer.byteLength(payload);
if (payloadBytes > MAX_BODY_BYTES) {
  die(`the ${format} report at '${REPORT}' serialises to ${payloadBytes} bytes, over the ${MAX_BODY_BYTES} the tracker accepts per run `
    + `(${tests.length} test case(s); the ceiling is ${MAX_TESTS} tests x ${BYTES_PER_TEST} bytes) — `
    + 'shard the test run and report each shard separately, or shorten the test titles');
}

const endpoint = `${TRACKER_URL.replace(/\/$/, '')}/api/projects/${PROJECT}/requirements/test-results`;
console.log(`report-tests: ${tests.length} test(s), ${payloadBytes} bytes @ ${SHA} (${ENVIRONMENT}) -> ${endpoint}`);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

let attempt = 1;
for (;;) {
  let status = 0;
  let text = '';
  let retryAfter = null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: payload,
    });
    status = res.status;
    text = await res.text().catch(() => '');
    const header = res.headers.get('retry-after');
    if (header !== null && /^\d+$/.test(header.trim())) retryAfter = Number(header.trim());
  } catch (err) {
    // A network failure is retried on the same schedule as a 5xx. The
    // message is printed, never the request — an error string from `fetch`
    // does not carry headers, but nothing here formats one either.
    text = err instanceof Error ? err.message : 'network error';
  }

  if (status >= 200 && status < 300) {
    console.log(`report-tests: recorded (HTTP ${status}). ${text.slice(0, 500)}`);
    process.exit(0);
  }
  // 413 joins the terminal set: a payload does not shrink on a retry, and
  // the response comes from the body parser, so it carries no validation
  // detail to reconcile — the local size check above is what names the
  // remedy, and reaching this means the tracker's ceiling is lower than the
  // one mirrored here.
  if (status === 400 || status === 401 || status === 403 || status === 413) {
    console.error(`report-tests: refused with HTTP ${status} — this will not succeed on a retry.`);
    if (status === 413) {
      console.error(`report-tests: the request body was ${payloadBytes} bytes for ${tests.length} test case(s) — `
        + 'shard the test run and report each shard separately.');
    }
    console.error(text.slice(0, 2000));
    process.exit(1);
  }
  if (attempt >= MAX_ATTEMPTS) {
    console.error(`report-tests: giving up after ${attempt} attempts (last status ${status || 'network failure'}).`);
    console.error(text.slice(0, 2000));
    process.exit(1);
  }

  let delay = retryAfter !== null ? retryAfter : BACKOFF_BASE_SECONDS * (2 ** (attempt - 1));
  if (delay > MAX_DELAY_SECONDS) {
    console.error(`report-tests: clamping a ${delay}s retry delay to ${MAX_DELAY_SECONDS}s.`);
    delay = MAX_DELAY_SECONDS;
  }
  console.error(`report-tests: HTTP ${status || 'network failure'} — retrying in ${delay}s (attempt ${attempt}/${MAX_ATTEMPTS}).`);
  await sleep(delay * 1000);
  attempt += 1;
}
