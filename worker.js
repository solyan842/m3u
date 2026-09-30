const MAIN_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/iptv.m3u";
const PUBLIC_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/public.m3u";
const VTHANH_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/vthanhtivi-fpt-test.m3u";
const VTV8_UPSTREAM = "https://vips-livecdn.fptplay.net/hda2/vtv8hd_vhls.smil/chunklist_b5000000.m3u8";

function absolutizeHlsManifest(text, baseUrl) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) return line;

      if (!trimmed.startsWith("#")) {
        try {
          return new URL(trimmed, baseUrl).toString();
        } catch {
          return line;
        }
      }

      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          return `URI="${new URL(uri, baseUrl).toString()}"`;
        } catch {
          return match;
        }
      });
    })
    .join("\n");
}

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

    if (url.pathname === "/vtv8" || url.pathname === "/vtv8.m3u8") {
      const upstream = await fetch(VTV8_UPSTREAM, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          "Referer": "https://fptplay.vn/",
          "Origin": "https://fptplay.vn"
        },
        cf: {
          cacheTtl: 5,
          cacheEverything: true
        }
      });

      if (!upstream.ok) {
        return new Response("VTV8 manifest unavailable\n", {
          status: 502,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*"
          }
        });
      }

      const finalUrl = upstream.url || VTV8_UPSTREAM;
      const manifest = absolutizeHlsManifest(await upstream.text(), finalUrl);

      return new Response(manifest, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }

    const isPublic = url.pathname === "/public" || url.pathname === "/public.m3u";
    const isVThanh =
      url.pathname === "/vthanh" ||
      url.pathname === "/vthanh.m3u" ||
      url.pathname === "/vthanhtivi" ||
      url.pathname === "/vthanhtivi.m3u";

    const upstreamUrl = isPublic
      ? PUBLIC_UPSTREAM
      : isVThanh
        ? VTHANH_UPSTREAM
        : MAIN_UPSTREAM;

    const filename = isPublic
      ? "public.m3u"
      : isVThanh
        ? "vthanhtivi-fpt-test.m3u"
        : "iptv.m3u";

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
