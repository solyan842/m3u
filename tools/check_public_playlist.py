#!/usr/bin/env python3
# Triggered health audit for current playlist.
# Audit trigger: current playlist HEAD 2026-09-26.
import concurrent.futures
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

PLAYLIST = Path("public.m3u")
TIMEOUT = 10
MAX_WORKERS = 16
READ_LIMIT = 65536

def parse_header_tail(raw_url):
    if "|" not in raw_url:
        return raw_url, {}
    url, tail = raw_url.split("|", 1)
    headers = {}
    for pair in tail.split("&"):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k = k.strip()
        v = urllib.parse.unquote(v.strip())
        if k.lower() in ("referer", "referrer"):
            headers["Referer"] = v
        elif k.lower() == "user-agent":
            headers["User-Agent"] = v
        elif k.lower() == "origin":
            headers["Origin"] = v
        elif k.lower() == "cookie":
            headers["Cookie"] = v
    return url.rstrip("?&"), headers

def parse_playlist(text):
    channels = []
    current = None
    pending = {}
    for raw in text.splitlines():
        line = raw.replace("\ufeff", "").replace("\u200b", "").replace("\u3164", "").strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            name = line.rsplit(",", 1)[-1].strip() if "," in line else "Unknown"
            gm = re.search(r'group-title="([^"]*)"', line, re.I)
            im = re.search(r'tvg-id="([^"]*)"', line, re.I)
            current = {
                "name": name,
                "group": gm.group(1).strip() if gm else "",
                "tvg_id": im.group(1).strip() if im else "",
            }
            pending = {}
            continue
        m = re.match(r"#EXTVLCOPT:http-user-agent=(.*)", line, re.I)
        if m:
            pending["User-Agent"] = m.group(1).strip().strip('"')
            continue
        m = re.match(r"#EXTVLCOPT:http-referr?er=(.*)", line, re.I)
        if m:
            pending["Referer"] = m.group(1).strip().strip('"')
            continue
        if current and re.match(r"^https?://", line, re.I):
            url, url_headers = parse_header_tail(line)
            headers = dict(pending)
            headers.update(url_headers)
            item = dict(current)
            item["raw_url"] = line
            item["url"] = url
            item["headers"] = headers
            channels.append(item)
            current = None
            pending = {}
    return channels


def fetch_url(url, headers, ctx, limit=READ_LIMIT, range_bytes=None):
    h = dict(headers)
    if range_bytes:
        h["Range"] = range_bytes
    req = urllib.request.Request(url, headers=h, method="GET")
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
        status = getattr(resp, "status", None) or resp.getcode()
        data = resp.read(limit)
        return status, resp.geturl(), resp.headers.get("Content-Type", ""), data

def first_media_uri(text):
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            for j in range(i + 1, len(lines)):
                if not lines[j].startswith("#"):
                    return "variant", lines[j]
    for line in lines:
        if not line.startswith("#"):
            return "segment", line
    return None, None

def drm_info(text):
    tags = [x.strip() for x in text.splitlines() if x.strip().startswith("#EXT-X-KEY")]
    if not tags:
        return {"encrypted": False, "drm": False, "tags": []}
    drm = any(("SAMPLE-AES" in t.upper()) or ("KEYFORMAT" in t.upper()) for t in tags)
    return {"encrypted": True, "drm": drm, "tags": tags[:4]}

def deep_probe_hls(text, base_url, headers, ctx):
    info = {
        "deep_ok": False,
        "variant_status": None,
        "segment_status": None,
        "segment_bytes": 0,
        "encrypted": False,
        "drm": False,
        "drm_tags": [],
        "deep_error": "",
    }
    try:
        kind, uri = first_media_uri(text)
        current_text = text
        current_url = base_url

        d = drm_info(current_text)
        info["encrypted"] = d["encrypted"]
        info["drm"] = d["drm"]
        info["drm_tags"] = d["tags"]

        if kind == "variant" and uri:
            variant_url = urllib.parse.urljoin(current_url, uri)
            st, final_url, _ct, data = fetch_url(variant_url, headers, ctx)
            info["variant_status"] = st
            if not (200 <= int(st) < 400):
                info["deep_error"] = f"Variant HTTP {st}"
                return info
            current_text = data.decode("utf-8", "ignore")
            current_url = final_url
            if "#EXTM3U" not in current_text:
                info["deep_error"] = "Variant is not HLS"
                return info
            d = drm_info(current_text)
            info["encrypted"] = info["encrypted"] or d["encrypted"]
            info["drm"] = info["drm"] or d["drm"]
            info["drm_tags"] = (info["drm_tags"] + d["tags"])[:4]
            kind, uri = first_media_uri(current_text)

        if kind != "segment" or not uri:
            info["deep_error"] = "No media segment found"
            return info

        segment_url = urllib.parse.urljoin(current_url, uri)
        st, _final, _ct, data = fetch_url(
            segment_url, headers, ctx, limit=4096, range_bytes="bytes=0-4095"
        )
        info["segment_status"] = st
        info["segment_bytes"] = len(data)
        if 200 <= int(st) < 400 and len(data) > 0:
            info["deep_ok"] = not info["drm"]
            if info["drm"]:
                info["deep_error"] = "DRM/SAMPLE-AES detected"
        else:
            info["deep_error"] = f"Segment HTTP {st}"
    except Exception as e:
        info["deep_error"] = f"{type(e).__name__}: {e}"
    return info

def is_hls_url(url):
    low = url.lower()
    return ".m3u8" in low or low.endswith(".m3u") or "/hls/" in low or "manifest" in low or "chunklist" in low or "playlist" in low

def check_channel(ch):
    started = time.time()
    headers = {
        "Accept": "*/*",
        "Connection": "close",
        "User-Agent": "SolYan-IPTV-HealthCheck/1.0",
    }
    headers.update(ch.get("headers") or {})
    req = urllib.request.Request(ch["url"], headers=headers, method="GET")
    ctx = ssl.create_default_context()
    result = {
        "name": ch["name"],
        "group": ch["group"],
        "tvg_id": ch["tvg_id"],
        "url": ch["url"],
        "headers": ch.get("headers") or {},
        "ok": False,
        "status": None,
        "final_url": None,
        "content_type": "",
        "bytes_read": 0,
        "kind": "",
        "error": "",
        "elapsed_ms": 0,
        "deep_ok": None,
        "variant_status": None,
        "segment_status": None,
        "segment_bytes": 0,
        "encrypted": False,
        "drm": False,
        "deep_error": "",
    }
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            result["status"] = getattr(resp, "status", None) or resp.getcode()
            result["final_url"] = resp.geturl()
            result["content_type"] = resp.headers.get("Content-Type", "")
            data = resp.read(READ_LIMIT)
            result["bytes_read"] = len(data)
            text = data.decode("utf-8", "ignore")
            ctype = result["content_type"].lower()
            if "#EXTM3U" in text:
                result["kind"] = "hls"
                result["ok"] = 200 <= int(result["status"]) < 400
                if ch["group"] in ("HTV", "SCTV", "VTVcab", "Box", "PUBLIC"):
                    deep = deep_probe_hls(text, result["final_url"] or ch["url"], headers, ctx)
                    result.update(deep)
                    result["ok"] = bool(deep["deep_ok"])
            elif ctype.startswith("audio/") or ctype.startswith("video/") or "octet-stream" in ctype:
                result["kind"] = "media"
                result["ok"] = 200 <= int(result["status"]) < 400 and len(data) > 0
            elif not is_hls_url(ch["url"]) and 200 <= int(result["status"]) < 400 and len(data) > 0:
                result["kind"] = "stream"
                result["ok"] = True
            else:
                result["kind"] = "unexpected"
                result["error"] = "HTTP responded but payload is not an HLS manifest/media stream"
    except urllib.error.HTTPError as e:
        result["status"] = e.code
        result["final_url"] = getattr(e, "url", None)
        result["error"] = f"HTTP {e.code}: {e.reason}"
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    result["elapsed_ms"] = int((time.time() - started) * 1000)
    return result

def main():
    text = PLAYLIST.read_text(encoding="utf-8-sig")
    channels = parse_playlist(text)
    print(f"Checking {len(channels)} channels with {MAX_WORKERS} workers, timeout={TIMEOUT}s")
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        results = list(ex.map(check_channel, channels))

    by_group = defaultdict(lambda: {"total": 0, "ok": 0, "fail": 0})
    for r in results:
        g = r["group"] or "Khác"
        by_group[g]["total"] += 1
        if r["ok"]:
            by_group[g]["ok"] += 1
        else:
            by_group[g]["fail"] += 1

    summary = {
        "total": len(results),
        "ok": sum(1 for r in results if r["ok"]),
        "fail": sum(1 for r in results if not r["ok"]),
        "groups": dict(sorted(by_group.items(), key=lambda kv: kv[0].lower())),
    }
    Path("public-health.json").write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")

    md = []
    md.append("# PUBLIC IPTV Health Report")
    md.append("")
    md.append(f"- Total: **{summary['total']}**")
    md.append(f"- OK: **{summary['ok']}**")
    md.append(f"- FAIL: **{summary['fail']}**")
    md.append("")
    md.append("## By group")
    md.append("")
    md.append("| Group | Total | OK | FAIL | Success |")
    md.append("|---|---:|---:|---:|---:|")
    for g, s in summary["groups"].items():
        pct = (s["ok"] / s["total"] * 100) if s["total"] else 0
        md.append(f"| {g} | {s['total']} | {s['ok']} | {s['fail']} | {pct:.1f}% |")
    md.append("")
    md.append("## Failed channels")
    md.append("")
    for r in results:
        if not r["ok"]:
            md.append(f"- **{r['group']} / {r['name']}** — {r['error'] or r['status']} — `{r['url']}`")
    Path("public-health-report.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("\nFAILED CHANNELS")
    for r in results:
        if not r["ok"]:
            extra = ""
            if r.get("deep_ok") is not None:
                extra = f" | deep={r.get('deep_ok')} variant={r.get('variant_status')} segment={r.get('segment_status')} drm={r.get('drm')} deep_error={r.get('deep_error')}"
            print(f"[FAIL] {r['group']} | {r['name']} | status={r['status']} | {r['error']} | {r['url']}{extra}")

if __name__ == "__main__":
    main()
