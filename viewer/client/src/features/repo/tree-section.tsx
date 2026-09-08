/**
 * The Working trees section — the reclaim surface.
 *
 * The inspector is where a reclaim decision actually gets made, so it spells out
 * the thing the table can only badge: WHAT this console knows about this
 * directory, and how. A `record` row can name the run, its status and whether it
 * is still live; a `by name` row is a guess from a directory or branch name that
 * anybody could have written, and it is the row where "delete it, nothing owns
 * it" is most likely to be wrong.
 *
 * Nothing here deletes anything, deliberately — see `checkouts.tsx`.
 */

import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import { Button, Card, CardBody, CardHeader, CardTitle, KeyValue, PageError, Spinner } from '@/components/ui';
import { useConsoleState, useRepoCheckouts } from '@/lib/queries';
import { homePath } from '@/lib/format';
import { CheckoutTable, ROLE_BLURB, ViaChip } from './checkouts';
import { repoHref } from './routes';
import { RepoInspector } from './inspector';

export default function TreeSection({ route }: { route: ViewProps['route'] }) {
  const repo = route.query.repo;
  const openDir = route.query.tree;
  const { data: state } = useConsoleState();
  const { data, isPending, error, refetch } = useRepoCheckouts();

  if (isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const open = openDir ? data.checkouts.find((c) => c.dir === openDir) : undefined;
  const close = () => navigate(repoHref('trees', { repo }), { replace: true });
  const home = state?.home;

  return (
    <>
      {/* No `repo=` on this one, and it is not an omission: one registry, one
          object database. Accepting a key would let it answer twice under two
          names for the same set of trees. */}
      <CheckoutTable
        view={data}
        {...(home !== undefined ? { home } : {})}
        {...(open ? { active: open.dir } : {})}
        onPick={(c) => navigate(repoHref('trees', { repo, tree: c.dir }))}
      />

      {open && (
        <RepoInspector
          open
          onClose={close}
          title={homePath(open.dir, home) ?? open.dir}
          description={ROLE_BLURB[open.role]}
          meta={<ViaChip checkout={open} />}
          record={open}
        >
          <Card>
            <CardHeader>
              <CardTitle>Working tree</CardTitle>
            </CardHeader>
            <CardBody>
              <KeyValue
                items={[
                  ['directory', <code className="font-mono text-2xs break-all">{open.dir}</code>],
                  ['role', open.role],
                  [
                    'standing on',
                    open.branch ? (
                      <code className="font-mono text-2xs">{open.branch}</code>
                    ) : open.detached ? (
                      <span className="text-2xs text-ink-muted">
                        <code className="font-mono">{open.detached}</code> — no branch, so it names where it
                        stands, exactly as its lock does.
                      </span>
                    ) : (
                      '—'
                    ),
                  ],
                  [
                    'attributed',
                    open.via === 'record' ? (
                      <span className="text-2xs text-ink-muted">
                        The run record: <code className="font-mono">{open.run.slug}</code>
                        {open.run.phase === undefined ? '' : `, phase ${open.run.phase}`}, run{' '}
                        <code className="font-mono">{open.run.runId}</code>
                        {open.run.status ? `, ${open.run.status}` : ''} —{' '}
                        {open.run.live ? 'and a runner is driving it now.' : 'and it has stopped.'}
                      </span>
                    ) : open.via === 'branch' ? (
                      <span className="text-2xs text-ink-muted">
                        The NAME only — read as <code className="font-mono">{open.run.slug}</code>
                        {open.run.phase === undefined ? '' : `, phase ${open.run.phase}`}. No record claims
                        this tree: it may be a killed console&rsquo;s orphan, or a checkout somebody made by
                        hand and is working in right now.
                      </span>
                    ) : (
                      <span className="text-2xs text-ink-muted">
                        Nothing claims it and nothing about its name suggests a run.
                      </span>
                    ),
                  ],
                  [
                    'managed',
                    open.managed
                      ? 'Under the console’s own state directory — something it created.'
                      : 'Outside the console’s state directory. It did not make this.',
                  ],
                  open.prunable
                    ? [
                        'prunable',
                        'git still lists this checkout and its directory is gone. `git worktree prune` clears the listing.',
                      ]
                    : null,
                ]}
              />
              {open.branch && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(repoHref('branches', { repo, branch: open.branch }))}
                  >
                    This tree&rsquo;s branch
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(repoHref('graph', { repo, ref: open.branch }))}
                  >
                    Walk it
                  </Button>
                </div>
              )}
            </CardBody>
          </Card>
        </RepoInspector>
      )}
    </>
  );
}
