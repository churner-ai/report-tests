# Report test results to Churner

Churner derives each requirement's status from tests that actually ran. This
action posts one run's results.

A test declares what it proves by naming the requirement's key in its
**title**:

```js
it("R42: exports the user's data as CSV", () => { /* … */ });
test('[R42] [R43] csv export rejects an empty selection', () => { /* … */ });
```

The key comes from the title and never from the file path — a directory is a
filing decision, not a claim.

## Add it to a workflow

```yaml
      - name: Run tests
        run: npm test -- --reporter=junit --outputFile=junit.xml
        continue-on-error: true

      - name: Report to Churner
        if: always()
        uses: churner-ai/report-tests@v1
        with:
          token: ${{ secrets.CHURNER_PREVIEW_TOKEN }}
          project: MC
          sha: ${{ github.event.pull_request.head.sha || github.sha }}
          pr: ${{ github.event.pull_request.number }}
          report: junit.xml
          environment: ci
          report-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

`continue-on-error` on the test step plus `if: always()` here is deliberate:
a failing suite is exactly the run whose results Churner most needs.

## Inputs

See `action.yml`. `token` is the project's **preview token**, minted in the
project's Access settings — the same one the preview-contract action uses.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `token` | yes | — | The project's preview token, from a repository secret. |
| `project` | yes | — | Churner project key, e.g. `MC`. |
| `sha` | yes | — | Commit the run tested, 7-64 hex chars. Use the head sha on a `pull_request` event, not `github.sha`. |
| `report` | yes | — | Path to a JUnit XML or vitest/Jest JSON report. |
| `environment` | no | `ci` | `preview` \| `ci` \| `production`. |
| `format` | no | `auto` | `junit` \| `vitest-json` \| `auto` (chosen from the file extension). |
| `pr` | no | `''` | Pull-request number, when there is one. |
| `report-url` | no | `''` | Where the full report can be read. |
| `tracker-url` | no | `https://churner.ai` | Base URL of the Churner instance. Must be **https** unless the host is loopback. |
| `max-attempts` | no | `5` | Tries before the step fails. Only 429 / 5xx / network failures are retried. |
| `backoff-seconds` | no | `1` | Base of the exponential backoff. Any single wait is clamped at 60s. |

## How a test names what it proves

Linking is by the `R<n>` keys found in the test's **title**, parsed the same
way Churner's own registry parses a change-op key. A title naming several
keys writes one row per key; a title naming none — or naming only a key that
does not exist in the project — writes one **orphan** row that carries the
name verbatim, which is how you discover you wrote `R99` for a requirement
that was never created (or was retired). Nothing here recomputes a
requirement's status: this action only reports evidence, and status is
derived on read.

## What the action does about each response

| Response | Behaviour |
|---|---|
| `200` | Exit 0. |
| `400` | Exit 1, printing the response body — every violation the route reported. Retrying an invalid report changes nothing. |
| `401` | Exit 1. The token is wrong, missing, or has been rotated. Re-mint it in the project's Access settings and update the repository secret. |
| `403` | Exit 1. |
| `413` | Exit 1. The body was over the size ceiling below. It came from the body parser, so it carries no detail — the action prints the byte count and the test count itself. A payload does not shrink on a retry. |
| `429` | Retried, honouring `Retry-After` **from the response headers** and clamping any single wait at 60s. Churner rate-limits *failed* token verifications per project; a token that has verified once is not subject to it. |
| `5xx` / network failure | Retried with exponential backoff, then exit 1. |

Only `429` and `5xx` (and a network failure) are retried. A `400`, `401`,
`403` or `413` will answer identically on the next attempt, and retrying one
only delays the red step that tells you what to fix.

## How big one run may be

Two bounds, and the second is derived from the first so they cannot
contradict each other:

| Limit | Value | Enforced |
|---|---|---|
| Tests per run | **5000** | By the action before anything is sent, and by the route (`400`). |
| Request body | **1,600,000 bytes** (5000 × 320) | By the action before anything is sent, and by the route's body parser (`413`). |

Both refusals name the same remedy: **shard the test run and report each
shard separately** — one `report-tests` step per shard, each with the same
`sha`. Shards accumulate; the route is idempotent per (test, requirement),
so nothing is lost by splitting a run in two.

320 bytes per test is the per-entry budget the body cap assumes. A
`{ id, name, status }` entry serialises to roughly 120-180 bytes at
realistic `file::name` and title lengths, so a report at the test ceiling
fits with close to 2x of margin; only pathologically long test titles reach
the byte cap before the test cap.

## The token is never printed

Nothing in the action echoes the token on any path — happy, refused, or
retry-exhausted. GitHub's log masking is a backstop, not a licence to print
it.

## `tracker-url` must be https

The preview token rides in a header on **every** request, so plaintext hands
it to anything on the path. Loopback (`127.0.0.1`, `localhost`, `[::1]`) is
the one exception, because that is how the action's own tests run and there
is no network to intercept.

## This repository is published, not authored

The files here are copied from `github-actions/report-tests/` in the churner
monorepo, where they are edited, reviewed and tested against a stub of
Churner's own route. Do not patch them here — the next release overwrites
the file, and the change would never have run against the action's test
suite.

The tests live in the monorepo at `server/tests/report-tests-action.test.ts`
and **execute this script**, against a Fastify stub of the tracker's
test-results route — so they test the shipped program rather than a
re-parse of the YAML.

```
# from a churner monorepo checkout
cd server && npx vitest run tests/report-tests-action.test.ts
```
