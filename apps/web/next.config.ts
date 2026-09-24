import type { NextConfig } from 'next';

const common = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@whale-street/core'],
  async headers() {
    return [
      // The stock widget is meant to be framed by any site.
      {
        source: '/embed/:path*',
        headers: [...common, { key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
      },
      // Everything else refuses to be framed elsewhere.
      {
        source: '/((?!embed/).*)',
        headers: [
          ...common,
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
