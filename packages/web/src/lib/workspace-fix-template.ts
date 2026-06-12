import type { WorkspaceHealth, WorkspaceHealthReason } from "@first-tree/shared";

/**
 * Builders for the degraded-workspace Fix flow (design:
 * docs/degraded-workspace-design.md 附录 A). The Fix button creates a
 * dedicated fix chat with the degraded agent and sends this template as the
 * first message **in the user's own voice** — the agent then walks the user
 * through repairing local gh/git credentials via the GitHub device flow.
 *
 * Language follows the clicking user's browser locale (zh → A.1, else A.2);
 * the zh template string is user-facing product content, mirrored verbatim
 * from the design appendix.
 *
 * Security constraints are part of the template text itself: device flow
 * only, no PAT creation/printing/storage, no secrets in chat, no remote
 * reconfiguration; SSH keys only as a last resort (public key only).
 */

/** True when the browser locale should get the Chinese template. */
export function isZhLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/** Human label for a degraded repo's reason code, per template language. */
export function workspaceHealthReasonLabel(reason: WorkspaceHealthReason | undefined, zh: boolean): string {
  switch (reason) {
    case "git_clone_auth_failed":
      return zh ? "无法鉴权或凭证失效" : "authentication failed or credentials expired";
    case "git_repo_not_found":
      return zh ? "404 不可达" : "not found (404)";
    case "git_not_installed":
      return zh ? "git 未安装" : "git is not installed";
    default:
      return zh ? "不可达" : "unreachable";
  }
}

/**
 * One template line per degraded entry (`{{repos}}`), tree included as a
 * sibling row of the source repos (§3.0 — the mechanisms are isomorphic).
 */
export function degradedRepoLines(health: WorkspaceHealth, zh: boolean): string[] {
  const lines: string[] = [];
  for (const repo of health.repos) {
    if (repo.status === "ok") continue;
    lines.push(
      zh
        ? `- ${repo.url}（${workspaceHealthReasonLabel(repo.reasonCode, zh)}）`
        : `- ${repo.url} (${workspaceHealthReasonLabel(repo.reasonCode, zh)})`,
    );
  }
  if ((health.tree.status === "stale" || health.tree.status === "unreachable") && health.tree.repoUrl) {
    const label = workspaceHealthReasonLabel(health.tree.reasonCode, zh);
    lines.push(
      zh ? `- ${health.tree.repoUrl}（Context Tree，${label}）` : `- ${health.tree.repoUrl} (Context Tree, ${label})`,
    );
  }
  return lines;
}

/** Topic of the dedicated fix chat. */
export function buildWorkspaceFixTopic(hostname: string): string {
  return `Fix GitHub access on ${hostname}`;
}

const ZH_TEMPLATE = `我的 agent 工作区提示有团队仓库在这台机器（{{hostname}}）上无法访问，原因是本地 GitHub 凭证缺失或失效。请你在这个对话里一步步帮我修好本地的 gh 和 git 凭证。涉及的仓库：

{{repos}}

请按下面流程做，需要我配合的地方直接在对话里告诉我：

1. 先体检再动手：检查 \`gh --version\`、\`gh auth status\`、\`git config --global credential.helper\` 的现状，把发现告诉我。如果 gh 已经登录了对上述仓库有权限的账号，直接跳到第 5 步验证。
2. 安装 gh（如缺失）：按本机操作系统选择安装方式（macOS 用 Homebrew；Debian/Ubuntu 用官方 apt 源；其他按 gh 官方文档）。如果你没有安装权限，把需要我自己执行的命令原样发给我。
3. 用 device flow 登录（绝对不要让我在对话里粘贴任何 token 或密码）：
   - 注意你的 shell 没有交互式 TTY，直接跑 \`gh auth login\` 会失败。用伪终端把它放到后台跑并把输出写进日志文件，例如借助 \`script\` 命令并预先用管道喂一个回车，然后从日志文件里读出一次性配对码（形如 XXXX-XXXX）。
   - 把配对码和地址 https://github.com/login/device 发给我，提醒我用「对上述仓库有访问权限的那个 GitHub 账号」登录并输入配对码。
   - 发完就结束这一轮，等我回复"好了"再继续，不要空转等待。配对码约 15 分钟过期，过期就重新发起一次并给我新码。
   - 我回复后用 \`gh auth status\` 确认登录成功。
4. 接管 git 凭证：执行 \`gh auth setup-git\`，让普通 git 命令通过 gh 走 HTTPS 凭证。
5. 逐个验证：对上面每个仓库跑 \`git ls-remote <HTTPS 形式的 url>\`，告诉我哪些通了。仍不通的，帮我区分两种情况：我的账号没有权限（我需要找团队管理员开权限），还是仓库已被删除/改名（我需要去改 agent 的仓库配置）。
6. 收尾：全部通过后告诉我修复完成，工作区的警告会在下一个会话开始时自动消失。

约束：全程优先 device flow；不要创建、打印或保存任何 personal access token；任何密钥不得出现在这个对话里；不要改动工作区里任何仓库的 remote 配置。只有当 HTTPS 在这台机器上确实走不通时，才退而求其次引导我配置 SSH key（用 ssh-keygen 生成，把公钥加到我的 GitHub 账号——只有公钥可以出现在对话里）。`;

const EN_TEMPLATE = `My agent workspace reports that some team repositories are unreachable from this machine ({{hostname}}) because local GitHub credentials are missing or no longer valid. Please fix the local gh and git credentials with me, step by step, right here in this chat. Affected repositories:

{{repos}}

Follow this flow, and tell me directly in chat whenever you need me to act:

1. Diagnose before changing anything: check \`gh --version\`, \`gh auth status\`, and \`git config --global credential.helper\`, and report what you find. If gh is already logged in to an account that can access the repos above, skip straight to step 5.
2. Install gh if missing, using the right method for this OS (Homebrew on macOS; the official apt repo on Debian/Ubuntu; otherwise per the official gh docs). If you lack permission to install, send me the exact commands to run myself.
3. Log in via the device flow (never ask me to paste a token or password into this chat):
   - Note your shell has no interactive TTY, so a bare \`gh auth login\` will fail. Run it in the background under a pseudo-TTY (e.g. via the \`script\` command, piping a newline in advance) with output redirected to a log file, then extract the one-time code (XXXX-XXXX) from the log.
   - Send me the code and https://github.com/login/device, reminding me to sign in with the GitHub account that actually has access to the repos above.
   - Then end your turn and wait for me to reply "done" — do not busy-wait. The code expires in ~15 minutes; if it does, start a fresh attempt and send me the new code.
   - After I reply, confirm with \`gh auth status\`.
4. Take over git credentials: run \`gh auth setup-git\` so plain git uses gh over HTTPS.
5. Verify each repository above with \`git ls-remote <HTTPS url>\` and tell me which are now reachable. For any that still fail, help me distinguish: my account lacks access (I need to ask a team admin) vs. the repo was deleted/renamed (I need to fix the agent's repo config).
6. Wrap up: once everything passes, tell me the fix is complete and that the workspace warning will clear automatically when the next session starts.

Constraints: prefer the device flow throughout; do not create, print, or store any personal access token; no secret may ever appear in this chat; do not modify any repository's remote configuration in the workspace. Only if HTTPS genuinely cannot work on this machine, fall back to guiding me through SSH key setup (ssh-keygen, then add the public key to my GitHub account — only the public key may appear in chat).`;

/** First message of the fix chat, in the clicking user's voice and locale. */
export function buildWorkspaceFixMessage(opts: { health: WorkspaceHealth; hostname: string; locale: string }): string {
  const zh = isZhLocale(opts.locale);
  const template = zh ? ZH_TEMPLATE : EN_TEMPLATE;
  return template
    .replace("{{hostname}}", opts.hostname)
    .replace("{{repos}}", degradedRepoLines(opts.health, zh).join("\n"));
}
