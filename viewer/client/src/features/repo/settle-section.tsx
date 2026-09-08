/**
 * The Settles section — how each run's work reached the trunk, or why it did not.
 *
 * The filter is by plan slug, because that is the question people actually
 * arrive with ("did MY plan land?"). It is a query parameter like everything
 * else here, so a filtered view is quotable.
 */

import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import { Button, Input, PageError, Spinner } from '@/components/ui';
import { useRepoSettles } from '@/lib/queries';
import { SettleTable } from './settles';
import { repoHref } from './routes';

export default function SettleSection({ route }: { route: ViewProps['route'] }) {
  const repo = route.query.repo;
  const slug = route.query.slug;
  const { data, isPending, error, refetch } = useRepoSettles(slug ? { slug } : {});

  if (isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get('slug') ?? '').trim();
          navigate(repoHref('settles', { repo, slug: value || undefined }));
        }}
      >
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Plan</span>
          <Input name="slug" defaultValue={slug ?? ''} placeholder="every plan" className="w-56" />
        </label>
        <Button size="sm" type="submit" variant="ghost">
          Filter
        </Button>
        {slug && (
          <Button size="sm" variant="ghost" onClick={() => navigate(repoHref('settles', { repo }))}>
            Clear
          </Button>
        )}
      </form>
      <SettleTable view={data} />
    </div>
  );
}
