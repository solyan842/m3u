const UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/iptv.m3u";

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

    const upstream = await fetch(UPSTREAM, {
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

    const body = await upstream.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
        "content-disposition": "inline; filename=\"iptv.m3u\""
      }
    });
  }
};
