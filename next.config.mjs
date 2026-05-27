/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    // Auto-tree-shake lucide-react so the radar route only ships the ~11 icons
    // it imports, not the full library.
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
