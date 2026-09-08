/**
 * The Branches section — every local branch, what claims it, how far it has run.
 *
 * The inspector is where the two kinds of claim are told apart at length: `run`
 * is read from the branch NAME and `heldBy` comes from the checkout registry.
 * The second is what makes a branch unsafe to delete; the first is a guess that
 * looks exactly like it in a list.
 */

import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  KeyValue,
  PageError,
  Spinner,
} from '@/components/ui';
import { useConsoleState, useRepoBranches } from '@/lib/queries';
import { homePath, relativeTime } from '@/lib/format';
import { BranchTable, divergence } from './branches';
import { repoHref } from './routes';
import { RepoInspector } from './inspector';

export default function BranchSection({ route }: { route: ViewProps['route'] }) {
  const repo = route.query.repo;
  const openName = route.query.branch;
  const { data: state } = useConsoleState();
  const { data, isPending, error, refetch } = useRepoBranches(repo);

  if (isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const open = openName ? data.branches.find((b) => b.name === openName) : undefined;
  const close = () => navigate(repoHref('branches', { repo }), { replace: true });
  const home = state?.home;

  return (
    <>
      <BranchTable
        view={data}
        {...(home !== undefined ? { home } : {})}
        {...(open ? { active: open.name } : {})}
        onPick={(b) => navigate(repoHref('branches', { repo, branch: b.name }))}
      />

      {open && (
        <RepoInspector
          open
          onClose={close}
          title={open.name}
          {...(open.subject !== undefined ? { description: open.subject } : {})}
          meta={
            <>
              {open.current && <Badge tone="accent">checked out</Badge>}
              {open.trunk && <Badge tone="ok">trunk</Badge>}
              {open.run && (
                <Chip tone="accent" mono>
                  {open.run.slug}
                  {open.run.phase === undefined ? '' : ` · p${open.run.phase}`}
                </Chip>
              )}
            </>
          }
          record={open}
        >
          <Card>
            <CardHeader>
              <CardTitle>Branch</CardTitle>
            </CardHeader>
            <CardBody>
              <KeyValue
                items={[
                  ['head', <code className="font-mono text-2xs break-all">{open.head}</code>],
                  ['upstream', open.upstream ?? 'none — this branch is not tracked'],
                  ['divergence', divergence(open)],
                  ['author', open.author ?? '—'],
                  [
                    'last commit',
                    open.at && !Number.isNaN(Date.parse(open.at))
                      ? `${relativeTime(Date.parse(open.at))} · ${new Date(open.at).toLocaleString()}`
                      : '—',
                  ],
                  open.run
                    ? [
                        'run (from the name)',
                        // Said in full here because the chip cannot: this is a
                        // reading of a string an operator can type, and the row
                        // beside it (`held by`) is the one backed by evidence.
                        <span className="text-2xs text-ink-muted">
                          {open.run.slug}
                          {open.run.phase === undefined ? '' : `, phase ${open.run.phase}`} — parsed from the
                          branch name. Nothing here consulted a run record.
                        </span>,
                      ]
                    : null,
                  [
                    'held by',
                    open.heldBy?.length ? (
                      <ul className="flex flex-col gap-0.5">
                        {open.heldBy.map((dir) => (
                          <li key={dir} className="min-w-0 truncate font-mono text-2xs" title={dir}>
                            {homePath(dir, home) ?? dir}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-2xs text-ink-muted">
                        No working tree stands on it — from the checkout registry, which is evidence rather
                        than a reading.
                      </span>
                    ),
                  ],
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(repoHref('graph', { repo, ref: open.name }))}
                >
                  Walk this branch
                </Button>
                {data.trunk && data.trunk !== open.name && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(repoHref('diff', { repo, base: data.trunk, tip: open.name }))}
                  >
                    Diff against {data.trunk}
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
        </RepoInspector>
      )}
    </>
  );
}
