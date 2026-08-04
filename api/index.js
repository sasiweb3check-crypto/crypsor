/**
 * Vercel function entry — loads the esbuild-bundled Express app.
 * Plain JS so Vercel does not typecheck the TypeScript source tree
 * (nodenext + extensionless imports fails on Hobby builds).
 */
export { default } from "../artifacts/api-server/dist/vercel.mjs";
