# This repository is published, not authored

`action.yml`, `report-tests.mjs` and `README.md` are copied verbatim
from `github-actions/report-tests/` in the churner monorepo, which is
where they are edited, reviewed and tested. Do not patch them here: the next
release overwrites the file, and the change would never have run against the
action's test suite (which executes `report-tests.mjs` against a stub of
the tracker's own test-results route).

Released from churner monorepo commit `bf602e5`.
