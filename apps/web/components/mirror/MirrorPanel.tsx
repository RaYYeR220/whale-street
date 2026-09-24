'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider } from 'wagmi';
import type { CompanyView } from '../../lib/api-types';
import { walletConfig } from '../../lib/mirror/wallet-config';
import { MirrorTicket } from './MirrorTicket';

/** Wallet providers live only here, so wagmi loads with the Mirror ticket and nowhere else. */
export default function MirrorPanel({ view }: { view: CompanyView }) {
  const [client] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={client}>
        <MirrorTicket view={view} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
