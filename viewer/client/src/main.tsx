import {
  StrictMode,
  Suspense,
  type ComponentType,
} from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { App } from './App';
import { createQueryClient } from './lib/queries';
import { persistOptions, revalidateRestored } from './lib/persist';
import { applyDensity, applyTheme, getPrefs } from './lib/prefs';
import { installErrorReporting } from './lib/report-error';
import './styles/theme.css';

// Before React renders, not inside it: a theme applied in an effect means the
// first paint is the wrong one and the app flashes Night at someone who chose
// Paper. `theme.css` declares both grounds, so this attribute is the whole
// switch and it costs one DOM write.
applyTheme(getPrefs().theme);
applyDensity(getPrefs().density);

// Before React renders, so a throw during the very first mount is reported
// rather than lost. `ErrorBoundary` catches what happens while RENDERING a
// destination; these two are the classes it structurally cannot see — a throw
// from an event handler or a timer, and a promise nobody awaited.
installErrorReporting();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

/** What this document boots — the console's App, unless the page says otherwise. */
function rootComponent(): ComponentType {
  return App;
}

const Root = rootComponent();

const queryClient = createQueryClient();

// The cache from the last time this browser had the console open, if there is
// a store to keep one in. `PersistQueryClientProvider` holds fetching for the
// microtask the restore takes, which is the point: a query that fires BEFORE
// the restore lands is the double request the persistence exists to remove.
//
// `null` — a private window, storage refused — is not a failure mode with a
// branch of its own. The app runs as it always did, from the network.
const persistence = persistOptions();

createRoot(root).render(
  <StrictMode>
    {persistence ? (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistence}
        onSuccess={() => revalidateRestored(queryClient)}
      >
        <Suspense fallback={null}>
          <Root />
        </Suspense>
      </PersistQueryClientProvider>
    ) : (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <Root />
        </Suspense>
      </QueryClientProvider>
    )}
  </StrictMode>,
);
