import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent's data files are read at runtime by the API routes. Tracing them
  // explicitly guarantees Vercel ships them with the serverless bundle.
  outputFileTracingIncludes: {
    "/api/agent/feed": ["./data/**"],
    "/api/agent/init": ["./data/**"],
    "/": ["./data/**"],
  },
};

export default nextConfig;
