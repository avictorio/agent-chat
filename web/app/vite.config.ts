import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
  server: {
    // The API contract (@chat/contract) lives in the repo's top-level
    // contract/, outside the web workspace the dev server serves by default.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), "../../contract"] },
  },
});
