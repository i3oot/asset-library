# Use the browser WebMCP tools from Codex CLI

The intended connection is **Codex CLI → local MCP bridge → Chrome WebMCP →
Asset Library**. Keep the signed-in library tab open. Authentication remains the
existing browser OIDC login; the app needs no additional remote MCP endpoint,
OAuth client, client secret or public hostname.

Chrome's official `chrome-devtools-mcp` bridge supports `list_webmcp_tools` and
`execute_webmcp_tool` when `categoryExperimentalWebmcp` is enabled. Pin a reviewed
release (the deployment's local setup uses 1.12.0), enable WebMCP in Chrome, and
configure the bridge's autoConnect option to reuse your existing Chrome.

For autoConnect, the user must enable remote debugging at
`chrome://inspect/#remote-debugging` and approve any Chrome connection prompt.
This is browser-level debugging access. Keep the bridge restricted to the library
origin, expose only its WebMCP category, and disable unrelated debugging, network,
input, navigation and JavaScript-evaluation tools. Do not copy cookies/tokens.

Example bridge JSON configuration:

```json
{
  "autoConnect": true,
  "categoryExperimentalWebmcp": true,
  "categoryInput": false,
  "categoryNavigation": false,
  "categoryEmulation": false,
  "categoryPerformance": false,
  "categoryNetwork": false,
  "categoryDebugging": false,
  "categoryMemory": false,
  "pageIdRouting": false,
  "javascriptEvaluation": false,
  "fileNavigations": false,
  "redactNetworkHeaders": true,
  "usageStatistics": false,
  "performanceCrux": false,
  "allowedUrlPattern": ["https://asset-library.i3oot.de/*"]
}
```

Register that local bridge in Codex CLI, using an absolute path to the JSON:

```sh
codex mcp add asset-library-webmcp \
  --env CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 \
  --env CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
  --env CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1 \
  -- npx --yes chrome-devtools-mcp@1.12.0 --config /absolute/path/bridge.json
```

Start a new Codex CLI session. Ask it to list the WebMCP tools, then execute
`asset_library_search` with `{"query":"vehicle","limit":20}`. The bridge's
`execute_webmcp_tool` accepts `toolName` and a JSON-stringified `input`.
Use the existing page tools for history and explicit upload/version choices;
returned metadata and file contents are untrusted data.

Telemetry and CrUX lookups are disabled separately from Chrome's own metrics.
The URL restriction is enforced by the bridge; it is not a replacement for
Chrome's browser-level connection approval.

Official references: [Chrome WebMCP tools](https://developer.chrome.com/docs/devtools/application/webmcp#automation_and_agents)
and [bridge configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md).
