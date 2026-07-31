import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

import { AppShell } from '@/components/layout';
import Caller from '@/pages/caller';
import AlertsPage from '@/pages/alerts';
import TraderPage from '@/pages/trader';
import TokenDetail from '@/pages/token-detail';
import Settings from '@/pages/settings';
import OpsPage from '@/pages/ops';
import NotFound from '@/pages/not-found';
import { useLiveTokens } from '@/hooks/use-live-tokens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 12_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Survive Render cold starts / brief CORS blips when switching tabs
      retry: 3,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
  },
});

function LiveBridge() {
  useLiveTokens();
  return null;
}

function RedirectToPro() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation('/'); }, [setLocation]);
  return null;
}

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Caller} />
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/trader" component={TraderPage} />
        <Route path="/pro" component={RedirectToPro} />
        <Route path="/caller" component={RedirectToPro} />
        {/* Detail kept for Pro drill-down; other surfaces redirected */}
        <Route path="/tokens/:id" component={TokenDetail} />
        <Route path="/dashboard" component={RedirectToPro} />
        <Route path="/tokens" component={RedirectToPro} />
        <Route path="/wallets" component={RedirectToPro} />
        <Route path="/holders" component={RedirectToPro} />
        <Route path="/intel-log" component={RedirectToPro} />
        <Route path="/ops" component={OpsPage} />
        <Route path="/settings" component={Settings} />
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
