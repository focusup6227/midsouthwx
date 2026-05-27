/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    // Auto-tree-shake lucide-react so the radar route only ships the ~11 icons
    // it imports, not the full library.
    optimizePackageImports: ['lucide-react'],
    // sharp has native bindings; bundling it into the server output via
    // webpack breaks at runtime on Vercel's Node Lambda. Marking it external
    // makes Next require() it at runtime from node_modules instead. Used by
    // the alert reflectivity stitcher (lib/snapshot/reflectivity-render.ts).
    serverComponentsExternalPackages: ['sharp'],
  },
};

export default nextConfig;
