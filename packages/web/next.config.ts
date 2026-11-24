import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Single source of truth for the version: the root package.json (the API reads the same file).
const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string }

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false, // do not advertise the framework in every response
  env: {
    NEXT_PUBLIC_VEQSIO_VERSION: rootPkg.version,
    NEXT_PUBLIC_VEQSIO_BUILD: (process.env.VEQSIO_BUILD || 'dev').slice(0, 64),
  },
  reactStrictMode: true,
  devIndicators: false,
  // Bundled modules (modules/*, ee/modules/*) live outside this package; see scripts/gen-module-registry.ts.
  experimental: { externalDir: true },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/rest/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3040'}/rest/:path*`,
      },
      {
        source: '/scim/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3040'}/scim/:path*`,
      },
      {
        source: '/auth/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3040'}/auth/:path*`,
      },
    ]
  },
}

export default nextConfig
