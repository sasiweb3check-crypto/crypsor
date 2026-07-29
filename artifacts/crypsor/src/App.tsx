import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { AppShell } from '@/components/layout';
import Caller from '@/pages/caller';
import Settings from '@/pages/settings';
import TokenDetail from '@/pages/token-detail';
import NotFound from '@/pages/not-found';
import { useLiveTokens } from '@/hooks/use-live-tokens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

function LiveBridge() {
  useLiveTokens();
  return null;
}

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Caller} />
        <Route path="/settings" component={Settings} />
        <Route path="/tokens/:id" component={TokenDetail} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <LiveBridge />
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
