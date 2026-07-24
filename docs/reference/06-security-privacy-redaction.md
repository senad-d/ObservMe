# ObservMe Security, Privacy, and Redaction Specification

## 1. Security Philosophy

ObservMe observes AI agents that may process source code, credentials, logs, customer data, incident data, infrastructure names, filesystem paths, and proprietary prompts. Therefore, ObservMe must be privacy-preserving by default.

## 2. Default Capture Policy

Default configuration:

```yaml
capture:
  prompts: false
  responses: false
  thinking: false
  toolArguments: false
  toolResults: false
  bashCommands: false
  bashOutput: false
  filePaths: false  # reserved; no direct live file-path recording point
```

`capture.filePaths` does not gate paths embedded in other captured fields. It is accepted and shown by `/obs status`, but no current live handler records a standalone path content field. Recognized absolute paths inside enabled prompt, response, tool, or Bash content are controlled by `privacy.pathMode`; `full` preserves them regardless of `capture.filePaths`.

Failed-tool output is content, not default operational metadata. It may appear in the Tools dashboard only after `capture.toolResults` is explicitly enabled. The value must pass the shared capture policy before being emitted as the body of a dedicated `tool.error.captured` log; capture-disabled and fail-closed redaction paths emit no body. Broad session-log queries must exclude both `event.category="llm_content"` and `event.category="tool_content"`.

Default allowed metadata:

```text
lengths
hashes
counts
durations
status
model/provider
token usage
cost
tool names
error class
```

## 3. Data Classification

### Safe by Default

- Provider name
- Model name
- Token counts
- Cost numbers
- Stop reason
- Tool name
- Boolean success/failure
- Redacted error class
- Duration
- Generated agent role/depth metadata

### Sensitive

- User prompts
- Assistant responses
- Thinking/reasoning content
- Tool arguments
- Tool results
- Bash commands
- Bash output
- Full file paths
- Git remote URLs
- Environment variables
- Stack traces
- Raw parent process command lines or environment variables used to launch subagents

### Highly Sensitive

- API keys
- Tokens
- Passwords
- SSH keys
- Private certificates
- Personal data
- Customer data
- Proprietary code snippets

## 4. Redaction Pipeline

Every optional content field passes through:

```text
raw value
  -> size guard
  -> secret detector
  -> PII detector stage
  -> path scrubber
  -> custom regex redactors
  -> truncation
  -> hashing
  -> export
```

The helper supports an injected PII detector for programmatic use, but the current `ObservMeConfig` schema has no PII setting and live capture does not inject or enable a detector. The PII stage is therefore a pass-through in current extension telemetry. Do not rely on ObservMe as a PII scanner.

## 5. Secret Detection Patterns

Minimum built-in patterns:

```text
AWS access key id:           (A3T[A-Z0-9]|AKIA|ASIA)[0-9A-Z]{16}
Generic bearer token:        (?i)bearer\s+[a-z0-9._\-]{20,}
GitHub token:                (gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,255})
OpenAI-like key:             sk-[A-Za-z0-9_-]{20,}
Anthropic-like key:          sk-ant-[A-Za-z0-9_-]{20,}
Slack token:                 xox[baprs]-[A-Za-z0-9-]{10,}
Private key block:           complete uppercase labels ending in PRIVATE KEY (including PKCS#8, encrypted, RSA, and EC)
Password assignment:         (?i)(password|passwd|pwd)\s*[:=]\s*[^\s]+
API key assignment:          (?i)(api[_-]?key|token|secret|client[_-]?secret)\s*[:=]\s*[^\s]+
URL credentials:             [a-z][a-z0-9+.-]*://[^\s:/?#]+:[^\s@/]+@
```

These patterns are a minimum safety net, not a complete secret scanner. Keep them covered by tests and allow organizations to add custom regexes for proprietary credential formats.

Private-key matching consumes a `PRIVATE KEY` label with an optional, bounded uppercase prefix, its body, and a same-label `END` marker with a 1,000,000-character body scan bound. This covers PKCS#8 (`PRIVATE KEY`), `ENCRYPTED PRIVATE KEY`, `RSA PRIVATE KEY`, `EC PRIVATE KEY`, and other uppercase private-key labels without accepting public-key labels. The shared input-size guard drops larger captured values before secret matching. If a supported private-key marker has no matching footer because it is missing, truncated, or mislabeled, redaction fails closed by replacing everything from that marker through the end of the captured value. `PUBLIC KEY` and `RSA PUBLIC KEY` blocks are not private-key matches.

Matched values are replaced with:

```text
[REDACTED:<type>:<sha256-prefix>]
```

## 6. Path Redaction

Path recognition covers standalone and embedded POSIX absolute paths, Windows drive paths, and UNC paths. It must use the matching POSIX or Windows basename/dirname semantics and must not classify normal URLs or harmless slash-separated prose as filesystem paths.

Representative sensitive inputs:

```text
/home/alice/projects/customer-x/app.ts
/workspace/project/file.ts
/etc/hosts
C:\Users\alice\secret.txt
\\server\share\secret.txt
```

Options:

```yaml
privacy:
  pathMode: hash        # hash|basename|full|drop
```

`hash`, `basename`, and `drop` remove every recognized raw absolute path. Hashes are deterministic only within the configured tenant salt and fail closed when salt resolution fails. `drop` omits a standalone path and uses a bounded placeholder for an embedded path. `full` is the only explicit mode that preserves raw path text; it applies whenever another content field is enabled and does not depend on the reserved `capture.filePaths` flag. All other redaction stages still apply. URL credential redaction runs before path handling so the remaining URL is not malformed.

## 7. Hashing

Hashes are used for correlation without storing raw data.

Recommended minimum:

```text
sha256(tenant_salt + "\0" + normalized_value)
```

Preferred when the salt is secret:

```text
hmac_sha256(tenant_salt, normalized_value)
```

Use a tenant-specific salt to prevent cross-tenant dictionary attacks. The salt itself is a secret and must come from environment or secure runtime configuration.

## 8. Workflow and Agent Identity Privacy

Workflow, agent, and subagent lineage should use generated IDs or salted hashes only:

```text
pi.workflow.id
pi.workflow.root_agent_id
pi.agent.id
pi.agent.parent_id
pi.agent.root_id
pi.agent.spawn.id
```

Do not derive these IDs directly from raw cwd, username, prompt text, file path, shell command, PID, container name, or hostname. Treat parent-process command lines and inherited environment variables as sensitive; if they are captured for debugging, they must pass through the redaction pipeline first.

Workflow IDs and agent IDs are high-cardinality operational identifiers. They may be exported as resource/span/log attributes for drill-down, but they must not be metric labels by default.

## 9. Content Size Limits

Defaults:

```yaml
limits:
  maxPromptChars: 12000
  maxResponseChars: 12000
  maxToolArgumentChars: 8000
  maxToolResultChars: 16000
  maxBashOutputChars: 16000
  maxLogBodyChars: 32000
```

If content exceeds limit:

- Truncate
- Add attribute `observme.truncated=true`
- Add original length attribute

## 10. Opt-in LLM Content Export

Prompt, response, and thinking bodies are not exported by default. They become visible in Tempo and Loki only when the corresponding capture flag is enabled, redaction remains enabled, and a tenant hash salt is available for the session:

```text
OBSERVME_CAPTURE_PROMPTS=true
OBSERVME_CAPTURE_RESPONSES=true
OBSERVME_CAPTURE_THINKING=true
OBSERVME_REDACTION_ENABLED=true
OBSERVME_HASH_SALT=<project-specific-random-salt>
```

Set `OBSERVME_ALLOW_UNSAFE_CAPTURE=true` only with `OBSERVME_REDACTION_ENABLED=false` for intentionally raw local debugging. When redacted capture is enabled, ObservMe writes the already-redacted value to the LLM span attribute (`pi.llm.prompt.redacted`, `pi.llm.response.redacted`, or `pi.llm.thinking.redacted`) and emits one correlated Loki log whose body is the same redacted value.

Example:

```json
{
  "event.name": "llm.prompt.captured",
  "event.category": "llm_content",
  "pi.session.id": "...",
  "pi.turn.id": "...",
  "pi.llm.content.kind": "prompt",
  "trace_id": "...",
  "span_id": "...",
  "body": "<redacted prompt>"
}
```

The Collector cannot recover content dropped by an older configuration; generate new LLM events after updating the Collector and dashboards. Do not use raw chat text in Loki or Tempo query strings.

## 11. Authentication and Credential-Free Endpoint URLs

ObservMe supports OTLP headers:

```yaml
otlp:
  headers:
    Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}"
```

Grafana base URLs must be absolute HTTP(S) URLs without embedded username or password components. Configure Grafana authentication only through `query.grafana.token` or the complete `query.grafana.username` and `query.grafana.password` pair. A credential-bearing base URL is rejected during configuration validation and query readiness, before either Grafana transport can perform network I/O. Diagnostics report only the safe `embedded_credentials` failure class and dedicated setting names; they do not render the rejected URL or credential values.

Secrets must be read from environment variables or secure runtime config, not hardcoded in extension source or embedded in endpoint URLs.

## 12. TLS

Production default:

```yaml
otlp:
  endpoint: https://otel-collector.example.com:4318
  tls:
    insecureSkipVerify: false
```

The endpoint URL scheme selects TLS. The OTLP exporters explicitly keep certificate verification enabled unless `otlp.tls.insecureSkipVerify: true` is configured. Grafana query transport follows the same rule through `query.grafana.tls.insecureSkipVerify`. Production rejects either verification bypass, and any plain HTTP endpoint, unless `privacy.allowInsecureTransport: true` records the explicit insecure-transport acknowledgement. Development may use local HTTP or self-signed certificates, but the insecure setting remains visible in `/obs status` and `/obs health`.

## 13. Tenant Isolation

Set tenant and environment as resource attributes:

```yaml
resource:
  attributes:
    observme.tenant.id: platform
    deployment.environment.name: production
```

Never derive tenant solely from raw cwd or username.

## 14. Auditability

Implemented security-relevant diagnostics include bounded `config.rejected`, `redaction.failed`, `export.failed`, `handler.failed`, and `trace_context.propagation_failed` logs, plus secret-safe `/obs status` and `/obs health` output. Session startup attributes include the prompt/response/tool-argument capture flags and redaction state; `/obs status` reports all capture flags. ObservMe does not emit a separate startup audit log for every capture setting or a dedicated exporter-authentication event.

Do not log secrets while reporting security failures.

## 15. Safe Config Validation

Trusted project config, project `.env`, and starter-config creation share one filesystem boundary. Their lexical paths and canonical targets must remain inside the stable canonical project root. Existing symlinks are supported only when they resolve to files or directories inside that root; out-of-root, dangling, replaced, or unverifiable paths fail closed. Reads and starter writes use identity-verified file handles and recheck containment so a concurrent file, ancestor, or root change cannot substitute an external target. Before allocation, opened-file metadata also enforces a 256 KiB limit for global/project `observme.yaml` and a 128 KiB limit for project `.env`; oversized and sparse sources fail closed with a fixed path-free classification. A rejected project source is not loaded, starter creation does not overwrite an existing file, and diagnostics expose only a bounded failure class rather than canonical or external path details.

Reject config if:

- capture is enabled but redaction is disabled, unless `allowUnsafeCapture: true`
- an OTLP or Grafana endpoint is plain HTTP in production, unless `allowInsecureTransport: true`
- OTLP or Grafana certificate verification is bypassed in production, unless `allowInsecureTransport: true`
- metric labels include forbidden high-cardinality fields such as workflow IDs, session IDs, or agent IDs
- propagated workflow or agent lineage values are malformed, too long, or contain unsafe characters
- queue sizes exceed configured memory limits

## 16. Compliance Posture

ObservMe does not claim compliance by itself. It provides controls needed for organizations to implement compliant telemetry pipelines. Retention, access control, deletion, and legal policy are backend responsibilities.
