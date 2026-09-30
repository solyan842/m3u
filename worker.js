const MAIN_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/iptv.m3u";
const PUBLIC_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/public.m3u";
const VTHANH_UPSTREAM = "https://raw.githubusercontent.com/solyan842/m3u/main/vthanhtivi-fpt-test.m3u";

const VTV8_CANDIDATES = [
  {
    name: "SCTV",
    url: "https://e3.endpoint.cdn.sctvonline.vn/hls/vtv8/index.m3u8",
    headers: {
      "User-Agent": "ReactNativeVideo/3.4.4 (Linux;Android 9) ExoPlayerLib/2.13.3",
      "Referer": "http://sctvonline.vn"
    }
  },
  {
    name: "FPT-vips",
    url: "https://vips-livecdn.fptplay.net/hda2/vtv8hd_vhls.smil/chunklist_b5000000.m3u8",
    headers: {
      "User-Agent": "VThanhTivi"
    }
  },
  {
    name: "FPT53-live247",
    url: "https://live.fptplay53.net/live/media/vtv8/live247-hls-avc/index.m3u8",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    }
  },
  {
    name: "VTVGo-failover",
    url: "https://vtvgolive-failover.vtvdigital.vn/vtvgo/vtv8-manifest.m3u8",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Referer": "https://vtvgo.vn/channel/36",
      "Origin": "https://vtvgo.vn"
    }
  }
];

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

async function fetchVtv8Manifest() {
  const diagnostics = [];

  for (const candidate of VTV8_CANDIDATES) {
    try {
      const response = await fetch(candidate.url, {
        headers: candidate.headers,
        redirect: "follow",
        cf: {
          cacheTtl: 5,
          cacheEverything: true
        }
      });

      const text = await response.text();
      const isManifest = response.ok && text.includes("#EXTM3U");

      diagnostics.push(
        `${candidate.name}=${response.status}${isManifest ? ":ok" : ":invalid"}`
      );

      if (isManifest) {
        const finalUrl = response.url || candidate.url;
        return {
          manifest: absolutizeHlsManifest(text, finalUrl),
          source: candidate.name,
          diagnostics
        };
      }
    } catch (error) {
      diagnostics.push(
        `${candidate.name}=fetch-error:${error?.name || "Error"}`
      );
    }
  }

  return { manifest: null, source: null, diagnostics };
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
      const result = await fetchVtv8Manifest();

      if (!result.manifest) {
        return new Response(
          "VTV8 manifest unavailable\n" + result.diagnostics.join("\n") + "\n",
          {
            status: 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "access-control-allow-origin": "*"
            }
          }
        );
      }

      return new Response(result.manifest, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "x-solyan-vtv8-source": result.source
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
