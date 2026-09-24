/**
 * Wallet connection for Mirror only: wagmi v3 with the built-in injected() connector (EIP-6963
 * discovery lists MetaMask, Rabby and friends). No modal kit, no external project id.
 * The chains only matter for signing: Hyperliquid accepts user-signed actions from any chain id.
 */
import { createConfig, http, injected } from 'wagmi';
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains';

export const walletConfig = createConfig({
  chains: [arbitrum, mainnet, base, optimism],
  connectors: [injected()],
  transports: {
    [arbitrum.id]: http(),
    [mainnet.id]: http(),
    [base.id]: http(),
    [optimism.id]: http(),
  },
});

/** Highest builder fee we approve for Nansen, in tenths of a basis point (80 = 0.08%, the untiered ceiling). */
export const BUILDER_FEE_CEILING = 80;
