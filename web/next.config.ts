import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Heavy server-only packages stay out of the bundle.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    '@mastra/core',
    '@mastra/memory',
    '@mastra/pg',
    'pg',
  ],
  // Listing photos come from marketplace CDNs; plain <img> is used on purpose
  // (AR Quick Look needs a real <img> as the anchor's first child).
  images: { unoptimized: true },
  outputFileTracingIncludes: {
    '/api/**': ['./tests/fixtures/*.sql'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'microphone=(self), geolocation=(self), camera=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
