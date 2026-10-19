import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "../../chatgpt-auth";
import { privateJson } from "../../../lib/progress-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  return privateJson({
    user: user ? { id: user.userId, displayName: user.displayName } : null,
    signInUrl: chatGPTSignInPath("/#progress"),
    signOutUrl: chatGPTSignOutPath("/#progress"),
  });
}
