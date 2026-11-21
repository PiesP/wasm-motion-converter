/** Map a deployment inventory path to its canonical Cloudflare Pages URL. */
export function pagesFileUrl(target: URL | string, filePath: string): URL {
  const url = new URL('/', target);
  const path = `/${filePath}`;
  if (path.endsWith('/index.html')) {
    url.pathname = path.slice(0, -'index.html'.length);
  } else {
    url.pathname = path.endsWith('.html') ? path.slice(0, -'.html'.length) : path;
  }
  return url;
}
