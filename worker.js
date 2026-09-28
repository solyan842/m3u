const MAIN_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/iptv.m3u";
const PUBLIC_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/public.m3u";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    const isPublic = url.pathname === "/public" || url.pathname === "/public.m3u";
    const upstreamUrl = isPublic ? PUBLIC_UPSTREAM : MAIN_UPSTREAM;
    const filename = isPublic ? "public.m3u" : "iptv.m3u";

    const upstream = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "SolYan-IPTV-ShortURL/1.0"
      },
      cf: {
        cacheTtl: 60,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      return new Response("IPTV source unavailable\n", {
        status: 502,
        headers: {"content-type":"text/plain; charset=utf-8"}
      });
    }

    return new Response(await upstream.arrayBuffer(), {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
        "content-disposition": `inline; filename="${filename}"`
      }
    });
  }
};
