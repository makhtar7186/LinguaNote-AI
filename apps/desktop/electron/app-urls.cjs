// Which pages belong to this application. Used to decide which IPC senders are trusted and which navigations
// are allowed. Free of Electron imports.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PAGES = { main: "index.html", bubble: "bubble.html" };

/**
 * @param {{useDist: boolean, devUrl: string, distDir: string}} options
 *   useDist: load the built pages from disk (packaged app, or the smoke test); otherwise the Vite dev server.
 */
function createUrlPolicy({ useDist, devUrl, distDir }) {
  const distUrl = (file) => pathToFileURL(path.join(distDir, file)).href;
  const origin = devUrl.replace(/\/$/, "");

  const allowed = new Set(
    useDist
      ? Object.values(PAGES).map(distUrl)
      : [origin, `${origin}/`, ...Object.values(PAGES).map((file) => `${origin}/${file}`)],
  );

  return {
    useDist,
    /** File to load from disk (useDist) or URL of the dev server for the named page. */
    target(name) {
      if (!PAGES[name]) throw new RangeError(`Unknown page: ${name}`);
      return useDist ? path.join(distDir, PAGES[name]) : `${origin}/${name === "main" ? "" : PAGES[name]}`;
    },
    /** Exact page match (query string and fragment ignored): sibling paths and other origins are not app pages. */
    isAppUrl(url) {
      if (typeof url !== "string") return false;
      return allowed.has(url.split(/[?#]/)[0]);
    },
  };
}

module.exports = { createUrlPolicy, PAGES };
