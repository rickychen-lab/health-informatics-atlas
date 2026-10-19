import { siteHTML } from "../lib/site-shell";
export function GET() { return new Response(siteHTML, {headers: {"content-type":"text/html; charset=utf-8", "cache-control":"no-cache"}}); }
