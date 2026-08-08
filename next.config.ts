import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in a parent directory otherwise makes Next infer the wrong
  // workspace root, which breaks the data/** tracing below.
  outputFileTracingRoot: path.join(__dirname),

  // The agent's data files are read at runtime by the API routes. Tracing them
  // explicitly guarantees Vercel ships them with the serverless bundle.
  outputFileTracingIncludes: {
    "/api/agent/feed": ["./data/**"],
    "/api/agent/init": ["./data/**"],
    "/": ["./data/**"],
  },
};

export default nextConfig;
