// Root-level extension entrypoint. Pi derives the compact extension label
// from the entrypoint path segments; a root `index.ts` displays as the
// package directory name ("cascabel") instead of "src". The implementation
// lives in src/index.ts (tests import it there).
export { default } from "./src/index.js";
