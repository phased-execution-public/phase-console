import {
  StrictMode,
  Suspense,
  type ComponentType,
} from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { App } from './App';
import { createQueryClient } from './data/keys';
import { persistOptions, revalidateRestored } from './lib/persist';
import { staleShellCheck } from './lib/pwa';
import { applyDensity, applyPalette, applyTheme, getPrefs } from './lib/prefs';
import { installErrorReporting } from './lib/report-error';
import './styles/theme.css';

// Before React renders, not inside it: a theme applied in an effect means the
// first paint is the wrong one and the app flashes Night at someone who chose
// Paper. `theme.css` declares both grounds, so this attribute is the whole
// switch and it costs one DOM write.
applyTheme(getPrefs().theme);
applyDensity(getPrefs().density);
applyPalette(getPrefs().palette);

// Before React renders, so a throw during the very first mount is reported
// rather than lost: a throw from an event handler or a timer, and a promise
// nobody awaited, are the two classes the route boundary cannot see.
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
// `null` — a private window, storage refused — runs the app from the network.
const persistence = persistOptions();

function mount(into: HTMLElement): void {
  createRoot(into).render(
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
}

// A page the service worker served may be the release before an update (#373):
// asked BEFORE mounting, so the old app is never drawn and never pressed. On a
// mismatch the page reloads once onto the new build and this one never mounts.
void staleShellCheck({
  announce: () => {
    root.textContent = 'Updating to the new version of the console…';
  },
}).then(
  (verdict) => {
    if (verdict !== 'reloading') mount(root);
  },
  () => mount(root),
);
