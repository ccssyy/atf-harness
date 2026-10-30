/**
 * F7-2 锚：viewer token 直链——带 ?token= 且壳判 401 时 303 跳 `/?token=<原样 token>`
 * （cookie 由壳在根路径铸，viewer 侧不自建校验）；无 token 仍 401；有 cookie（reject
 * 返 undefined）时 200 路径不受影响。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { discoverViewerDirs, rawTokenFromUrl, VIEWER_ROUTE_PREFIX, viewerRouteHandler } from "../../packages/extensions/atf-ui/src/server.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type FakeReq = { url: string; method: string; headers: Record<string, string> };
type FakeRes = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: unknown;
  writeHead(c: number, h?: Record<string, unknown>): void;
  end(b?: unknown): void;
};

const fakeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: 0, headers: {}, body: undefined,
    writeHead(c, h) { res.statusCode = c; Object.assign(res.headers, h ?? {}); },
    end(b) { if (b !== undefined) res.body = b; },
  };
  return res;
};
const call = (handler: (req: IncomingMessage, res: ServerResponse) => void, req: FakeReq, res: FakeRes): void => {
  (handler as unknown as (r: FakeReq, s: FakeRes) => void)(req, res);
};

const seedViewer = (): { root: string; viewersOf: (runId: string) => string[] } => {
  const root = mkdtempSync(join(tmpdir(), "f7-token-"));
  roots.push(root);
  const viewerDir = join(root, "run-v", "analysis", "viewer");
  mkdirSync(viewerDir, { recursive: true });
  writeFileSync(join(viewerDir, "viewer.html"), "<html>latest</html>", "utf8");
  const viewers = discoverViewerDirs(join(root, "run-v"));
  return { root, viewersOf: (runId) => (runId === "run-v" ? viewers : []) };
};

const P = VIEWER_ROUTE_PREFIX;

describe("F7-2 viewer token 直链", () => {
  it("带 ?token= 且壳判 401 → 303 跳 /?token=<原样 token>（不解码不重编码）", () => {
    const { root, viewersOf } = seedViewer();
    const handler = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => 401 });
    const res = fakeRes();
    call(handler, { url: `${P}/run-v/?token=ab%2Fcd%3D`, method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/?token=ab%2Fcd%3D");
  });

  it("无 token → 行为不变（仍 401）", () => {
    const { root, viewersOf } = seedViewer();
    const handler = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => 401 });
    const res = fakeRes();
    call(handler, { url: `${P}/run-v/`, method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("token 空值 / 403 不跳（403 是拒绝不是未授权）", () => {
    const { root, viewersOf } = seedViewer();
    const handler401 = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => 401 });
    const empty = fakeRes();
    call(handler401, { url: `${P}/run-v/?token=`, method: "GET", headers: {} }, empty);
    expect(empty.statusCode).toBe(401);
    const handler403 = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => 403 });
    const forbidden = fakeRes();
    call(handler403, { url: `${P}/run-v/?token=abc`, method: "GET", headers: {} }, forbidden);
    expect(forbidden.statusCode).toBe(403);
  });

  it("有 cookie（reject 返 undefined）→ 200 路径不受影响", () => {
    const { root, viewersOf } = seedViewer();
    const handler = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => undefined });
    const res = fakeRes();
    call(handler, { url: `${P}/run-v/`, method: "GET", headers: { cookie: "dsh_session=x" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(String(res.body)).toContain("latest");
  });

  it("rawTokenFromUrl：原样取值，其它查询参数与无查询串不误判", () => {
    expect(rawTokenFromUrl("/atf-ui/viewer/r/?token=abc")).toBe("abc");
    expect(rawTokenFromUrl("/atf-ui/viewer/r/?a=1&token=ab%2Bc&b=2")).toBe("ab%2Bc");
    expect(rawTokenFromUrl("/atf-ui/viewer/r/?tokens=x")).toBeNull();
    expect(rawTokenFromUrl("/atf-ui/viewer/r/")).toBeNull();
    expect(rawTokenFromUrl(undefined)).toBeNull();
  });
});
