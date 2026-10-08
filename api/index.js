let appPromise;
export default async function handler(req, res) {
  appPromise ??= import("./vercel.mjs").then((module) => module.default);
  return (await appPromise)(req, res);
}
