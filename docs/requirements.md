# Requirements

To run the Windows app, configure a model provider, set the organization name, and connect a writable Punchlist folder.

Set these values in the control file, `src/control.ts`. It describes each setting and its allowed range.
Rebuild the app for changes to take effect. If a value is outside its range, the app stops and names the setting.

## 1. Model service

The app reaches its model service through one interface (`ModelService` in `src/backend/service.ts`), so the rest of the app works the same way whichever provider serves it. The `models.service` setting in the control file picks the provider. Every provider serves three tiers of model:

- Fast, for sorting and search
- Standard, for answers and drafts
- Thorough, a fallback after Standard fails twice on automated checks and an option in chat when enabled

The control file sets which model serves each tier. On screen, the service is only ever called by the name in `names.service` ("Intelligence" by default), never by a vendor's name.

| Provider | `models.service` | API and sign-in |
| --- | --- | --- |
| OpenAI-compatible | `'openai'` | Responses or Chat Completions API, with an API key. |
| Custom model gateway | `'gateway'` | OpenAI-compatible, with OAuth or an API key. |
| Azure OpenAI | `'azure'` | Responses API, with Microsoft Entra ID or a resource key. |
| Amazon Bedrock | `'bedrock'` | Claude on Bedrock Runtime, with IAM Identity Center or a Bedrock API key. |
| Google Vertex AI | `'vertex'` | Claude publisher models, with Google OAuth or a bound API key. |
| Anthropic (Claude API) | `'claude'` | Messages API, with an API key. |
| North (Cohere) | `'north'` | North API, with single sign-on or a developer token. |

Stand-in tests cover each route. An opt-in live smoke check covers sign-in, model discovery, file upload, a question
about that file, and cleanup on OpenAI-compatible, Anthropic, or North. The broader live end-to-end suite uses
Anthropic. See [Development](development.md#test-and-check).

The three original connectors follow these references. The other routes cite their references below.

- OpenAI: the [OpenAI API reference](https://developers.openai.com/api/reference/overview). An OpenAI-compatible server follows the same API.
- Anthropic: the [Claude API documentation](https://platform.claude.com/docs/en/api/overview).
- North (Cohere): see the [product overview](https://cohere.com/north). The setup section below names the relevant guide pages.

The control file turns on API key sign-in with `signIn.apiKey` and single sign-on with `signIn.sso`. The first sign-in
page and **Settings** offer the enabled methods for the selected provider. Direct Anthropic and OpenAI require the API key
option. North, custom model gateways, Azure OpenAI, Bedrock and Vertex support either or both. Each PC keeps its
credential encrypted on that PC, outside the shared folder. A refused or expired credential pauses model calls until the
person signs in again. The gateway, Azure, Bedrock and Vertex use the PC's browser for sign-in and repeat the sign-in flow
when the credential expires or is refused. North uses its own sign-in window.

For OAuth with a custom model gateway, Azure OpenAI, or Google Vertex AI, register a public desktop client for
authorization code with PKCE (S256). Use `http://127.0.0.1` as the loopback redirect with an ephemeral port
(`http://localhost` for Microsoft Entra). The browser returns a one-time code to the app on the same PC. The app
keeps the token until it expires and starts a fresh authorization flow when needed. Bedrock uses IAM Identity
Center's device authorization flow. [OAuth for native apps](https://datatracker.ietf.org/doc/html/rfc8252)

Every connector asks for at most `limits.outputTokens` output tokens per call (16,000 by default). The app sizes the parts of a request it can count to fit `limits.inputTokens` (180,000 by default). Where the service reports a smaller limit for a model (as North's model list does), the app uses that limit instead. Set both values to what the deployment's models allow.

When a reply is cut off at the length limit, the app asks again in smaller parts, or once more for a shorter reply. When
a request is refused as too long, the app asks again with fewer documents (see "AI and models" in
[decisions.md](decisions.md)). On every connector, one request may take up to `timings.modelCall` (10 minutes) before it
counts as unreachable.

### OpenAI (or an OpenAI-compatible server)

The connector uses the OpenAI-compatible API, so it can also reach an organization's own models behind a compatible server.

- **Account:** An OpenAI organization and project, with a standard API key created on the organization's API keys page ([API overview](https://developers.openai.com/api/reference/overview)). Rate limits apply per organization and project, not per user ([Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)).
- **Sign-in:** Paste an API key in **Settings**. The app sends it as `Authorization: Bearer <key>`
  ([API overview](https://developers.openai.com/api/reference/overview)). If the service refuses it with 401 or 403,
  the app waits for the person to sign in again.
- **Endpoints:** The API root comes from `openai.address` (`https://api.openai.com/v1` for OpenAI).
  - `POST /responses` by default, or `POST /chat/completions` when `openai.api` is `'chat'`
  - `GET /responses/{id}` to recover the tool calls of a stored chat response when resuming a conversation
  - `GET /models` to check a pasted key. If the endpoint returns 404, the app accepts the key unchecked.
  - `POST /files` with purpose `user_data` to upload, `GET /files?purpose=user_data` to list, and `DELETE /files/{id}`
    to remove an uploaded file ([File inputs](https://developers.openai.com/api/docs/guides/file-inputs)).

  Responses chats continue by `previous_response_id`. The service stores those responses for 30 days by default
  ([Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)). Other Responses calls use
  `store: false`. Chat Completions accepts PDFs by file ID. The app sends other documents as text in the message.
- **Models:** Set `models.openaiFast`, `models.openaiStandard`, and `models.openaiThorough` to model IDs from the
  selected endpoint. Each tier needs an ID. For OpenAI's hosted API, see [Models](https://developers.openai.com/api/docs/models).
- **Limits:** Files must be under 50 MB, with 50 MB total per request
  ([File inputs](https://developers.openai.com/api/docs/guides/file-inputs)). A call carries up to `limits.docsPerCall`
  (8) documents, so several large PDFs can exceed the request limit. The usage tier sets the request and token rates
  and spending limits (Free, Build, Launch, and Grow cap monthly spending at $100, $500, $5,000, and $200,000)
  ([Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)).
  The app sends `limits.outputTokens` through `max_output_tokens` or, for Chat Completions, `max_tokens`.
  A Responses reply with status `incomplete` or a Chat Completions reply with reason `length` is treated as cut off.
  A refusal or `content_filter` is treated as a decline.

  A busy response (408, 429, or 500 and up) is retried twice. Each retry waits for a numeric `Retry-After` up to a
  minute or uses the default delays of one then two seconds. A dropped connection is retried for reads and deletes
  or when the request never connected. A timeout or a failed attempt with no retries left counts as unreachable.
- **Control file:** Set the following values.

| Setting | Value |
| --- | --- |
| `models.service` | `'openai'` |
| `openai.address` | The API root, such as `https://api.openai.com/v1`. Required, and HTTPS only: a server on plain HTTP stops the app at startup. |
| `openai.api` | `'responses'` (the default) or `'chat'`. |
| `models.openaiFast`, `openaiStandard`, `openaiThorough` | The server's names for the three models. Required. |
| `signIn.apiKey` | Must be on. |

### Anthropic (Claude API)

- **Account:** An organization in the Claude Console, with API keys created on its API keys page. Workspaces keep keys and spending separate ([API overview](https://platform.claude.com/docs/en/api/overview)). The key must be created for a single workspace. A key that is not needs an `anthropic-workspace-id` header, which the app does not send ([API overview](https://platform.claude.com/docs/en/api/overview)).
- **Sign-in:** Paste an API key in **Settings**. The SDK sends it as `Authorization: Bearer <key>` with an
  `anthropic-version` header ([API overview](https://platform.claude.com/docs/en/api/overview)). When the service
  returns 401, calls wait for the person to sign in again. Opt-in live tests use `PUNCHLIST_AI_KEY`.
- **Endpoints:** Requests go to `https://api.anthropic.com`.
  - `POST /v1/messages` for inference, with uploaded documents referenced by file ID
  - `GET /v1/models` (one model) to check a pasted key
  - `POST /v1/files` to upload, `GET /v1/files` to list, and `DELETE /v1/files/{id}` to remove an uploaded file
    ([Files API](https://platform.claude.com/docs/en/build-with-claude/files)).

  The Files API takes PDFs and plain text as documents. LibreOffice converts Word and PowerPoint files to PDF and
  spreadsheets to text before sending. The file limit is 500 MB, with 1 TB of storage per organization. Files stay
  until deleted and are ineligible for zero data retention.
- **Models:** Set `models.claudeFast`, `models.claudeStandard`, and `models.claudeThorough` to Anthropic API model IDs.
  By default all tiers use `models.claudeFast` (Haiku). To use three separately configured tiers on a run, launch
  with `PUNCHLIST_LIVE_ROUTING=1`. [Models overview](https://platform.claude.com/docs/en/models/overview)
- **Limits:** The usage tier and model class determine request and token rates. The monthly spending cap is $500
  for Start, $1,000 for Build, $200,000 for Scale, and unlimited for Custom. A rate-limit 429 may carry
  `Retry-After`. Hitting the spending cap prevents calls until it resets
  ([Rate limits](https://platform.claude.com/docs/en/api/rate-limits)). The Messages API limits requests to 128 MB
  ([API overview](https://platform.claude.com/docs/en/api/overview)).
  The app sends `limits.outputTokens` as `max_tokens`. A reply with `stop_reason: max_tokens` is treated as cut off,
  and `stop_reason: refusal` is treated as a decline.

  A timeout counts as unreachable after one attempt. After a dropped connection, the SDK retries reads, deletes,
  and requests that failed to connect. A rate limit, overload, or server error that persists after the SDK's two
  retries counts as unreachable, so the check continues later.
- **Control file:** Set the following values.

| Setting | Value |
| --- | --- |
| `models.service` | `'claude'` |
| `models.claudeFast`, `claudeStandard`, `claudeThorough` | The API IDs of the fast, standard, and thorough models (see the note on tier routing under **Models**). |
| `signIn.apiKey` | Must be on. |

### Custom model gateway

- **Account and sign-in.** For OAuth, register a public desktop client with the identity provider configured for
  the gateway. Grant it the gateway's inference audience and the required scopes. The gateway accepts the resulting
  bearer access token. For API key sign-in, use a key issued by the gateway. Both send an `Authorization: Bearer`
  header. The OAuth token response gives the lifetime in `expires_in`.
  [OAuth token response](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)
  [Bearer authentication](https://datatracker.ietf.org/doc/html/rfc6750#section-2.1)
- **Endpoints and files.** The gateway uses the OpenAI-compatible connector. It calls `/chat/completions` or `/responses`,
  and checks a pasted key with `GET /models` where the gateway offers it. For PDF analysis the gateway must support the
  compatible `/files` operations and accept file IDs in inference requests. Chat Completions sends plain text and converted
  spreadsheets inline. [OpenAI API reference](https://developers.openai.com/api/reference/overview)
  [File inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- **Models and limits.** Use the IDs exposed by the gateway and set the input and output limits to fit the deployed models
  and gateway request limits.

| Setting | Value |
| --- | --- |
| `models.service` | `'gateway'` |
| `gateway.address` | Required HTTPS API root, such as `https://models.example.com/v1`. |
| `gateway.api` | `'chat'` or `'responses'`. |
| `gateway.authorize`, `gateway.token` | HTTPS OAuth authorization and token endpoints. Required for single sign-on. |
| `gateway.clientId`, `gateway.scope` | Public client ID and space-separated gateway access scopes. Required for single sign-on. |
| `gateway.fast`, `gateway.standard`, `gateway.thorough` | Required model IDs for the three tiers. |
| `signIn.sso`, `signIn.apiKey` | Which methods the app offers. |

### Azure OpenAI

- **Account and sign-in.** Set up an Azure OpenAI resource, deploy the three model tiers, and assign the users the
  Cognitive Services OpenAI User role. Register a public Microsoft Entra application in that tenant and configure the
  `http://localhost` loopback redirect under Mobile and desktop applications. Entra matches that redirect across
  ephemeral ports. The app requests
  `https://cognitiveservices.azure.com/.default` and sends the access token as `Authorization: Bearer`. Entra access
  tokens typically last 60 to 90 minutes. Punchlist uses the lifetime Entra returns and reauthorizes through the browser.
  Pasted resource keys are sent in `api-key`. [Entra authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
  [Loopback redirects](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions)
  [Access token lifetime](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#token-lifetime)
  [Azure OpenAI authentication](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/responses)
- **Endpoints and files.** The connector uses `POST /responses` and `GET /models` under `/openai/v1`. It sends PDFs inline
  as base64 data URLs and sends text and converted spreadsheets as input text. Chat responses use Azure’s stored response
  IDs. [Responses and PDF inputs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
  [Models API](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/models)
- **Models and limits.** Set the deployment name for each tier. For document work, use vision-capable deployments that
  support both Responses and PDF inputs. Set the input and output limits for those deployments.

| Setting | Value |
| --- | --- |
| `models.service` | `'azure'` |
| `azure.address` | Required HTTPS Responses API root, such as `https://RESOURCE.openai.azure.com/openai/v1`. |
| `azure.tenant`, `azure.clientId` | Entra directory and public application IDs. Required for single sign-on. |
| `azure.fast`, `azure.standard`, `azure.thorough` | Required Azure deployment names. |
| `signIn.sso`, `signIn.apiKey` | Which methods the app offers. |

### Amazon Bedrock

- **Account and sign-in.** Give users an IAM Identity Center assignment in the configured AWS account and permission set,
  and grant that role `bedrock:InvokeModel` for the chosen models. Punchlist registers a public OIDC client, opens the
  device approval page in the browser, and polls until it receives an IAM Identity Center access token. It exchanges that
  token for the configured account’s temporary role credentials via `GetRoleCredentials`. It signs each inference request
  using SigV4 for `bedrock`, including the session token in `X-Amz-Security-Token`. It signs in again at the returned AWS
  role expiration. The AWS permission set controls the role duration, one hour by default. A pasted Bedrock API key uses the
  `Authorization: Bearer` header. [Device authorization](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_StartDeviceAuthorization.html)
  [Role credentials](https://docs.aws.amazon.com/singlesignon/latest/PortalAPIReference/API_GetRoleCredentials.html)
  [Session duration](https://docs.aws.amazon.com/singlesignon/latest/userguide/howtosessionduration.html)
  [SigV4 and inference endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html)
  [API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)
- **Endpoints and files.** On Bedrock Runtime, `POST /model/{modelId}/invoke` sends Claude Messages with
  `anthropic_version: bedrock-2023-05-31`. PDFs are complete base64 documents. Text and converted spreadsheets go inline.
  Pasted keys are checked without inference at `POST /model/{modelId}/count-tokens`. Give the key permission for
  `bedrock:CountTokens` and use an in-Region Claude model that supports it. If all inference tiers use cross-Region
  profiles, set an in-Region `bedrock.probeModel` for key verification.
  [InvokeModel](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html)
  [Claude Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html)
  [CountTokens](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html)
  [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
- **Models and limits.** Use Claude Messages model IDs or inference profile IDs available in the selected Region. Choose
  PDF-capable models for document work. Bedrock caps InvokeModel request bodies at 25,000,000 bytes. Inline base64 adds
  about one third to the PDF size, so set document and token limits for the selected models.

| Setting | Value |
| --- | --- |
| `models.service` | `'bedrock'` |
| `bedrock.address`, `bedrock.region` | Required HTTPS Runtime origin and signing Region, such as `https://bedrock-runtime.us-east-1.amazonaws.com` and `us-east-1`. |
| `bedrock.ssoRegion`, `bedrock.startUrl` | IAM Identity Center Region and AWS access portal URL. Required for single sign-on. |
| `bedrock.account`, `bedrock.role` | AWS account ID and permission set role. Required for single sign-on. |
| `bedrock.fast`, `bedrock.standard`, `bedrock.thorough` | Required Claude model or inference profile IDs. |
| `bedrock.probeModel` | Optional in-Region Claude model for checking a pasted key. Defaults to the standard tier. |
| `signIn.sso`, `signIn.apiKey` | Which methods the app offers. |

### Google Vertex AI

- **Account and sign-in.** Enable the Vertex AI API and the Claude models in the project. Grant model prediction access to
  the users and, when offering keys, to the service account bound to the key. Create a Google OAuth Desktop app client and
  grant it the `cloud-platform` scope. The app sends the Google OAuth access token in `Authorization: Bearer`. The token
  normally lasts an hour, and Punchlist reauthorizes when the returned lifetime ends. The API key method uses a
  service-account-bound Google Cloud authorization key restricted to the Vertex AI API, sent in `x-goog-api-key`.
  [Desktop OAuth and renewal](https://developers.google.com/identity/protocols/oauth2/native-app)
  [Token types](https://docs.cloud.google.com/docs/authentication/token-types)
  [Vertex authorization keys](https://docs.cloud.google.com/docs/authentication/api-keys)
  [API key header](https://docs.cloud.google.com/docs/authentication/api-keys-use)
- **Endpoints and files.** The app uses Claude publisher model `POST /{model}:rawPredict` with
  `anthropic_version: vertex-2023-10-16`. PDFs are complete base64 documents. Text and converted spreadsheets go inline.
  The app checks a pasted key with the free `POST /count-tokens:rawPredict` call. When offering keys, choose a supported
  location and a standard model that supports token counting. If the project allowlists publisher models, allow the
  token-count endpoint too. [Claude predictions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude)
  [Count tokens](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/count-tokens)
  [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
- **Models and limits.** Use Claude model IDs available in the project and location. Choose PDF-capable models for
  document work. Set the input and output limits for those models and the project’s capacity.
  [Claude quotas](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/quotas)

| Setting | Value |
| --- | --- |
| `models.service` | `'vertex'` |
| `vertex.address` | Required HTTPS publisher root. For global, use `https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/global/publishers/anthropic/models`. |
| `vertex.clientId` | Google Desktop app OAuth client ID. Required for single sign-on. |
| `vertex.fast`, `vertex.standard`, `vertex.thorough` | Required Claude publisher model IDs. |
| `signIn.sso`, `signIn.apiKey` | Which methods the app offers. |

### North (Cohere)

The reference titles below are from Cohere's North documentation.

- **Account:** A North instance and a North account for each person, with access to all three models the app uses.
  When model role-based access control (RBAC) is on, which is the default, an administrator grants access under
  **Admin > Models**. See **Managing models and providers**.
- **Sign-in:** The app supports single sign-on or a developer token pasted in **Settings**. For single sign-on, the
  app opens the instance's sign-in page in its own window and reads the session token from the exact site in
  `north.ssoSite`. Find the developer token on the instance's `/developer` page under **Retrieve your token**. Each
  call sends `Authorization: Bearer <token>`. Calls wait for a new sign-in if a token is refused or expires. See
  **Quickstart** and **About the North API**.
- **Endpoints:** The API root is `<north.address>/api`. The app uses these endpoints.
  - `POST /v1/chat` with `stream: false`, the model name, and document IDs in `file_ids`. See **Chat**.
  - `POST /v1/files` and `GET /v1/files/{id}` to upload a file and wait for processing, `GET /v1/files` to list the
    app's files, and `DELETE /v1/files/{id}` to remove one
  - `GET /v1/users/me` for the person's name, and to check a pasted token before accepting it
  - `GET /v2/models` to list models, or `GET /v1/models` on instances without that route. See **List models**.

  Use an endpoint that accepts the bearer token directly. See **Identity-Aware Proxy (IAP) authentication** for
  details on deployments that require a separate IAP token header.
- **Models:** Set `models.northFast`, `models.northStandard`, and `models.northThorough` to API model identifiers
  from your instance's model list. Use the `name` field from `/v2/models` or the `id` field from `/v1/models`.
  Punchlist checks these identifiers when it connects. See **Managing models and providers**.
- **Limits:** North accepts an optional `max_tokens`. The **Chat** reference gives no default or maximum.
  The app sends `limits.outputTokens` or the model's own `max_tokens` from `/v2/models` when that is smaller.
  A reply ending with `finish_reason: MAX_TOKENS` is treated as cut off. When North is busy (429 or 503), the app
  waits as North asks, for up to four tries. North's My files has a 100 MB total limit. See **Supported files**.
  The app's separate `limits.storedFiles` limit counts files, so large files may reach North's limit first.
- **Control file:** Set the following values.

| Setting | Value |
| --- | --- |
| `models.service` | `'north'` |
| `north.address` | The instance's address, such as `https://north.example.com` (HTTPS, host only). Required. |
| `north.ssoSite` | The exact site whose sign-in cookie is the token. Required while `signIn.sso` is on. |
| `models.northFast`, `northStandard`, `northThorough` | The instance's API model identifiers for Fast, Standard, and Thorough. All three are required. |
| `north.hostedTools` | North's own tools, sent along with the chat agent's tools only when `models.toolCalls` is `'hybrid'` or `'native'`. `npm run ai:check -- north` lists the tools the instance offers. |
| `signIn.sso`, `signIn.apiKey` | Which ways to sign in the app offers. |
| `blackline.pipeline` | `'A'` for a model that may not see a blackline's strikethrough and colors, or `'B'` for one that does. |

### Settings for every provider

The app keeps up to `limits.storedFiles` (500 by default) of its own files and removes the least recently used.
Uploaded files live in the provider's file store. Documents sent inline are cached in the app instead.
Other files in a provider's store are left alone.

| Setting | Value |
| --- | --- |
| `names.service` | The name screens use for the model service (default "Intelligence"). |
| `names.aiContent` | The label that marks text the model wrote (default "AI"). |
| `models.toolCalls` | How the chat agent calls its tools: `'inline'` (the default), `'hybrid'`, or `'native'`. |
| `picker.fast`, `picker.standard`, `picker.thorough` | Which tiers the model picker offers. At least one must be on. |
| `limits.outputTokens` | The most tokens one reply may hold (default 16,000). Must not exceed what the deployment's models allow. |
| `limits.inputTokens` | The most tokens one request may send, documents included (default 180,000). Must not exceed the models' context window, less the output limit. |

## 2. Name and defaults

Set the following in the control file:

- **Name:** `firm.name` is the name Punchlist uses for questions you submit, responses you give, and deal memos.
  Set it before building. The app uses `[firm name]` if you leave the default unchanged (#635).
- **Workstreams** (optional): `firm.workstreams`, the list from which people and the model choose a finding's or question's workstream. The default is a starter list of 14. Each name may appear only once and may be up to 40 characters.
- **Colors** (optional): `colors.neutral`, `colors.accent`, and `colors.red`, each a `#rrggbb` color. The app works out every other color from these three. The current colors are the defaults. After a change, build the app again. If a base color would make text hard to read, the build stops and names the base color to change.

## 3. Install

- **Build the installer on a Windows PC:** Copy LibreOffice into `vendor/libreoffice` (see the README in that folder), then run `npm ci` and `npm run installer`. The installer is written to `out/installer`. It is not signed, so Windows SmartScreen shows a warning once.
- **Set up the Punchlist folder in OneDrive:** OneDrive provides automatic folder discovery and sync. Give the team
  edit access to the same folder.
  1. In OneDrive, create a folder named `Punchlist` (the name set in `desktop.sharedFolder`).
  2. Share the folder with everyone on the team, with the permission set to **Can edit**.
  3. Select the folder, click **Share**, then click **Copy link**. Paste the link into the control file as `desktop.teamFolderLink`.

  The [README](../README.md) describes each step in detail.

  If a team folder link is configured, **Open the Team Folder** opens it in OneDrive in the browser. Choose
  **Add shortcut to My files** there and let OneDrive sync the folder. Punchlist connects automatically when it
  discovers exactly one folder containing Punchlist records. For a new, empty folder, confirm the suggested path
  or choose the folder manually.
  If Punchlist finds several folders, select one and click **Use This Folder**. Change the folder in **Settings**.
- **Select a folder outside OneDrive:** Use the folder picker and confirm with **Use It Anyway**. Check that each
  PC can read and write the same records through the chosen storage. With OneDrive closed, Windows can report a
  reachable folder as out of sync and pause this PC's work on shared checks. NAS and SMB support is tracked in #111.

## 4. Checks after the first install

After the first install, check the following:

- That changes in the shared folder appear on both PCs
- That the Windows installer works
- That the chosen model service's replies keep to the JSON the app asks for and cite pages correctly

The live tests (`npm run e2e:live`) check model replies on the Claude API only. The AI check (`npm run ai:check -- <openai|claude|north>`) runs a short check on any of the three services, with the API key or North token in `PUNCHLIST_AI_KEY`.
