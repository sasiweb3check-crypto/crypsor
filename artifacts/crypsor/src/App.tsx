import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { Layout } from '@/components/layout';
import Dashboard from '@/pages/dashboard';
import Tokens from '@/pages/tokens';
import TokenDetail from '@/pages/token-detail';
import Settings from '@/pages/settings';
import Wallets from '@/pages/wallets';
import Holders from '@/pages/holders';
import IntelLog from '@/pages/intel-log';
import Feed from '@/pages/feed';
import { useLiveTokens } from '@/hooks/use-live-tokens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Longer stale time — SSE handles fresh updates
      staleTime: 30_000,
      gcTime:    5 * 60_000,
    },
  },
});

function LiveBridge() {
  // Opens SSE connection and patches React Query cache with real-time events
  useLiveTokens();
  return null;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/tokens" component={Tokens} />
        <Route path="/tokens/:id" component={TokenDetail} />
        <Route path="/wallets" component={Wallets} />
        <Route path="/holders" component={Holders} />
        <Route path="/settings" component={Settings} />
        <Route path="/intel-log" component={IntelLog} />
        <Route path="/feed" component={Feed} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
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
