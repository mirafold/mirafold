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

**Keep the current Gemini adapter on API keys.** There is positive evidence
for third-party interfaces driving Google's own CLI, but personal Gemini CLI
access has been retired. Removing Mirafold's subscription policy check cannot
restore that service or supply an authentication path the adapter lacks.

### What Mirafold actually does

[`GeminiCliSession`](../server/adapters/gemini-cli/gemini-cli.ts) launches the
installed official binary with `-p` and `-o stream-json`. It supplies rendering
guidance and an MCP server, and selects `gemini-api-key` in the project's
settings after workspace approval. It does not extract Google OAuth tokens
or make model requests directly. Credential detection in
[`server/adapters/index.ts`](../server/adapters/index.ts) accepts
`GEMINI_API_KEY` or `GOOGLE_API_KEY`; it does not detect a Google login.
Mirafold currently uses headless output, not Agent Client Protocol (ACP).

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
Mirafold's different headless interface or every account type. The same
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
Mirafold's existing Gemini CLI adapter.
[Gemini CLI team announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

Code Assist Standard/Enterprise or Antigravity could warrant separate work.
That requires reviewing the selected product's terms and authentication,
implementing its actual supported interface, and verifying the integration.
This review does not establish Antigravity compatibility or add enterprise
authentication. No live subscription calls were made for this research.

## Existing boundaries

Anthropic subscription access remains blocked at Kyle's direction. Its
existing assessment is in the policy module; it was not re-reviewed here.
Mirafold's paid relay continues to exclude subscriptions and free gateways.
That is the existing product boundary, independent of the supported local
ChatGPT path; this copy change does not alter it. OpenCode Zen retains its
separate terms and model-training disclosure.
