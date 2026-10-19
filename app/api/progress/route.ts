import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getProgressResponse, postProgressResponse } from "../../../lib/progress-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return getProgressResponse(await getChatGPTUser(), env.DB);
}

export async function POST(request: Request) {
  return postProgressResponse(request, await getChatGPTUser(), env.DB);
}
