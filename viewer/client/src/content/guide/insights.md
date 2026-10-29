# Tokens, cache and trends

Three places answer where the tokens and the money went and how the work is trending. **Logs ▸ Health**
keeps the machine's measures over time. Two more are Pro: **Insights ▸ Tokens & cache** spends a window
of the ledger by session, account, tool and lane, and **How the checks are trending** draws the eval
suite, the independent evaluator and the gates run by run.

## Logs ▸ Health over time

Health used to show only the present. It now keeps a series of four measures:

- **Gate time.** The full gate's seconds, one point for each run of `scripts/gates.sh`. The point is read
  from the marker the gate writes when it finishes, in the git directory of the repository it ran in.
- **Load.** The machine's five-minute load average divided by its cores, sampled every five minutes.
  This is the same reading the scheduler's load guard uses.
- **Persist time.** The mean milliseconds a run save took over each five minutes. A window with no save
  writes no point, never a zero.

## How long the series is kept

The series is bounded twice. Each measure keeps at most 2,100 points, and nothing older than 30 days
stays. The daily retention sweep rewrites the file without the excess. It lives in the console's state
directory as `health-series.ndjson`.

