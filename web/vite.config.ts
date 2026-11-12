import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the public website at / and the Referral Desk app at /app/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        site: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app/index.html"),
      },
    },
  },
});
