import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

import { AppShell } from '@/components/layout';
import Caller from '@/pages/caller';
import Dashboard from '@/pages/dashboard';
import Tokens from '@/pages/tokens';
import TokenDetail from '@/pages/token-detail';
import Settings from '@/pages/settings';
import Wallets from '@/pages/wallets';
import Holders from '@/pages/holders';
import IntelLog from '@/pages/intel-log';
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

/** Legacy aliases → Pro home */
function RedirectToPro() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation('/');
  }, [setLocation]);
  return null;
}

function Router() {
  return (
    <AppShell>
      <Switch>
        {/* Pro Intel — primary surface */}
        <Route path="/" component={Caller} />
        <Route path="/pro" component={RedirectToPro} />
        <Route path="/caller" component={RedirectToPro} />

        <Route path="/dashboard" component={Dashboard} />
        <Route path="/tokens" component={Tokens} />
        <Route path="/tokens/:id" component={TokenDetail} />
        <Route path="/wallets" component={Wallets} />
        <Route path="/holders" component={Holders} />
        <Route path="/intel-log" component={IntelLog} />
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
