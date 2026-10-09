import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** Only a local operator gate. Cloud deployment ALSO requires private ingress + IAM/IAP. */
function validOperatorAuthorization(header: string | null, username: string, password: string): boolean {
  if (!header?.startsWith("Basic ") || Buffer.byteLength(header) > 4096) return false;
  try {
    const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
    const expected = username + ":" + password;
    const actualDigest = createHash("sha256").update(raw).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actualDigest, expectedDigest);
  } catch { return false; }
}

export function proxy(request: NextRequest) {
  const user = process.env.ACCESSWRIGHT_DASHBOARD_USERNAME;
  const pass = process.env.ACCESSWRIGHT_DASHBOARD_PASSWORD;
  if (!user || !pass || user.includes(":") || pass.length < 20) {
    return new NextResponse("Dashboard operator credentials are not configured.", {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
  if (!validOperatorAuthorization(request.headers.get("authorization"), user, pass)) {
    return new NextResponse("Operator authorization required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="AccessWright private runs", charset="UTF-8"',
        "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  return NextResponse.next({ headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

export const config = { matcher: ["/", "/runs/:path*"] };
