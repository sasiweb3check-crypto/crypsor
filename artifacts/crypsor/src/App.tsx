import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

import { AppShell } from '@/components/layout';
import CallsPage from '@/pages/calls';
import CallDetailPage from '@/pages/call-detail';
import WalletTrackPage from '@/pages/wallet-track';
import Settings from '@/pages/settings';
import OpsPage from '@/pages/ops';
import NotFound from '@/pages/not-found';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 12_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 3,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
  },
});

function RedirectHome() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation('/'); }, [setLocation]);
  return null;
}

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={CallsPage} />
        <Route path="/calls/:id" component={CallDetailPage} />
        <Route path="/wallet-track" component={WalletTrackPage} />
        <Route path="/wallet" component={WalletTrackPage} />
        <Route path="/ops" component={OpsPage} />
        <Route path="/settings" component={Settings} />
        {/* Legacy surfaces removed from product — redirect home */}
        <Route path="/wallet/:address" component={RedirectHome} />
        <Route path="/alerts" component={RedirectHome} />
        <Route path="/trader" component={RedirectHome} />
        <Route path="/pro" component={RedirectHome} />
        <Route path="/caller" component={RedirectHome} />
        <Route path="/tokens/:id" component={CallDetailPage} />
        <Route path="/dashboard" component={RedirectHome} />
        <Route path="/tokens" component={RedirectHome} />
        <Route path="/wallets" component={RedirectHome} />
        <Route path="/holders" component={RedirectHome} />
        <Route path="/intel-log" component={RedirectHome} />
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
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
