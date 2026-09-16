# Provider subscriptions in Mirafold

Reviewed **2026-09-09** for Mirafold's actual adapters. The executable policy
remains in [`server/provider-policy.ts`](../server/provider-policy.ts).

## Codex and ChatGPT

ChatGPT login is a normal local connection option. Mirafold runs the official
`codex app-server`; OpenAI documents embedding that server into your own
product, including authentication, and describes a ChatGPT mode in which
Codex manages login, token storage, and refresh. This matches Mirafold's
integration. The former July assessment that the documentation did not
establish this path is superseded. Setup and credential selection carry no
subscription warning. [Official OpenAI documentation](https://learn.chatgpt.com/docs/app-server).

The existing OpenCode ChatGPT option also remains available without a
subscription warning, as requested by Kyle. OpenAI's app-server documentation
describes Codex's integration, not OpenCode's authentication implementation;
do not cite it as an endorsement of every third-party token-handling scheme.

## Gemini: distinguish the integration from the account entitlement

**Users may try their existing Gemini CLI sign-in locally.** Mirafold exposes
it as an available choice, with this account-availability guidance approved
by Kyle on September 9:

> **Try your Gemini CLI sign-in**
>
> Access depends on your Google account and plan. If subscription access is
> unavailable, connect with a Gemini API key instead.

This invites an attempt through the official CLI; it does not claim that a
retired consumer entitlement will work or that Google has endorsed Mirafold.

### What Mirafold actually does

[`GeminiCliSession`](../server/adapters/gemini-cli/gemini-cli.ts) launches the
installed official binary with `-p` and `-o stream-json`, rendering guidance,
and an MCP server. Its model catalog comes from the same binary's `--acp`
interface. Neither path extracts Google OAuth tokens or makes direct model
requests. Credential detection only checks whether
`~/.gemini/oauth_creds.json` exists (`GEMINI_CLI_HOME` replaces the home
prefix); it never parses that credential. A file's presence is not proof of
valid authentication or account entitlement.

API keys (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) remain the default when both
credentials exist. An explicit sign-in choice is preserved on restoration.
After Gemini-specific folder approval, the adapter merges its render server
and an environment reference into the project's authentication selection.
Each child sets that reference to `oauth-personal` or `gemini-api-key`, so
sessions sharing a folder keep separate choices. Outside Mirafold, that
setting retains the adapter's earlier API-key default; the trust prompt
states this effect. Native administrator policies still apply.
[Google's configuration layers and environment expansion](https://geminicli.com/docs/reference/configuration/).

Sign-in children receive empty API-key variables and `NO_BROWSER=true`.
The CLI handles its own cached credentials and refresh; an expired login
fails with its native authorization error instead of opening an interactive
login flow Mirafold cannot complete. Authentication/availability failures
retain Google's error and offer an explicit new API-key session. Mirafold
does not automatically switch to metered API usage.

### Evidence for the headless interface Mirafold uses

On March 16, Google project collaborator `jackwotherspoon` confirmed that
headless mode and custom system prompts are valid Gemini CLI uses. This
answered an issue reporting a suspension during scheduled official-CLI use;
he said he had asked the team and escalated the report. This directly
addresses Mirafold's interface more closely than the ACP example below.
[Maintainer clarification](https://github.com/google-gemini/gemini-cli/issues/20813#issuecomment-4067589940).

This is positive evidence for allowing local attempts. It does not establish
that Google “doesn't care,” that every account has access, or that suspension
cannot happen. The reporter described later suspensions too; the public
thread does not establish their actual trigger. Google's February statement
also acknowledged Antigravity enforcement against third-party access to its
resources/quotas and collateral Gemini CLI/Code Assist disruption from shared
backends. Consequently, “Google has never gone after anyone” would be false.
[Enforcement statement](https://github.com/google-gemini/gemini-cli/discussions/20632).

### The restriction is narrower than “all third-party apps are prohibited”

Google's terms notice prohibits direct access to the services behind Gemini
CLI through third-party software, with OpenClaw using Gemini CLI OAuth as
an example. Its FAQ specifically describes harvesting or piggybacking on
the CLI's OAuth authentication and directs third-party coding agents to API
keys. Those statements concern direct service access and token reuse; they
should not be rewritten into a blanket claim that every interface driving
the official binary is prohibited.
[Terms notice](https://geminicli.com/docs/resources/tos-privacy/),
[authentication FAQ](https://geminicli.com/docs/resources/faq/).

Google also documents third-party editor integrations through **Agent Client
Protocol**, the protocol connecting an agent to an editor. Gemini CLI is
available in the ACP registry for Zed, JetBrains, and other compatible editors.
That is affirmative support for the integration mechanism.
[Google's IDE integration documentation](https://geminicli.com/docs/ide-integration/).

In Google's March 18 service discussion, SaschaHeyer described automated use
through official ACP with the CLI's own Google login and no direct API
bypass. Project collaborator `bdmorgan` replied that it “sounds like a legitimate
use,” while qualifying that understanding. **Our reading:** this is evidence
of acceptance of that described integration, not a blanket guarantee for
every wrapper or account type. The same
announcement described increased enforcement against OAuth misuse, so
“Google tolerates third-party OAuth reuse” would misrepresent its posture.
[Original discussion and reply](https://github.com/google-gemini/gemini-cli/discussions/22970#discussioncomment-16198982).

### Personal access ended; enterprise access is a different path

Google's deprecation page, last updated September 2, says Gemini CLI and
Code Assist IDE extensions stopped serving individual, Google AI Pro, and
Google AI Ultra tiers on **June 18, 2026**. Their Google login is no longer
available for these products. Code Assist Standard and Enterprise remain
available. This current, explicit deprecation notice takes precedence over
the older general FAQ's instructions about Pro/Ultra quotas.
[Consumer-account deprecation](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).

Google's June 18 announcement separately confirms that API-key and licensed
enterprise access continue and names Antigravity CLI as the consumer
successor. Neither statement makes a personal subscription usable by
Mirafold merely by enabling its sign-in choice.
[Gemini CLI team announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

The option delegates entitlement checks to the official CLI. Enterprise
accounts may still need their native project/licensing configuration;
Mirafold does not provision a license. Antigravity remains a different
product and would require a separate adapter and review. No live
subscription or paid API calls were made for this change. Offline checks
verified the installed Gemini CLI 0.58 settings expansion; source inspection
checked native headless authentication and non-interactive login failure; fake-provider tests verify Mirafold's selection and failure paths.

## Existing boundaries

Anthropic subscription access remains blocked at Kyle's direction. Its
existing assessment is in the policy module; it was not re-reviewed here.
Mirafold's paid relay continues to exclude subscriptions and free gateways.
That is the existing product boundary, independent of the supported local
ChatGPT path; this change does not alter it. OpenCode Zen retains its
separate terms and model-training disclosure.
