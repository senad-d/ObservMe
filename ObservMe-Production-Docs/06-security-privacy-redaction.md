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
  filePaths: false
```

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

Every optional content field must pass through:

```text
raw value
  -> size guard
  -> secret detector
  -> PII detector if enabled
  -> path scrubber
  -> custom regex redactors
  -> truncation
  -> hashing
  -> export
```

## 5. Secret Detection Patterns

Minimum built-in patterns:

```text
AWS access key id:           (A3T[A-Z0-9]|AKIA|ASIA)[0-9A-Z]{16}
Generic bearer token:        (?i)bearer\s+[a-z0-9._\-]{20,}
GitHub token:                (gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,255})
OpenAI-like key:             sk-[A-Za-z0-9_-]{20,}
Anthropic-like key:          sk-ant-[A-Za-z0-9_-]{20,}
Slack token:                 xox[baprs]-[A-Za-z0-9-]{10,}
Private key block:           -----BEGIN [A-Z ]*PRIVATE KEY-----
Password assignment:         (?i)(password|passwd|pwd)\s*[:=]\s*[^\s]+
API key assignment:          (?i)(api[_-]?key|token|secret|client[_-]?secret)\s*[:=]\s*[^\s]+
URL credentials:             [a-z][a-z0-9+.-]*://[^\s:/?#]+:[^\s@/]+@
```

These patterns are a minimum safety net, not a complete secret scanner. Keep them covered by tests and allow organizations to add custom regexes for proprietary credential formats.

Matched values are replaced with:

```text
[REDACTED:<type>:<sha256-prefix>]
```

## 6. Path Redaction

Default behavior:

```text
/home/alice/projects/customer-x/app.ts -> /<home>/<hash>/app.ts
/Users/alice/work/acme-secret/main.py -> /<home>/<hash>/main.py
```

Options:

```yaml
privacy:
  pathMode: hash        # hash|basename|full|drop
```

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

## 11. Authentication

ObservMe supports OTLP headers:

```yaml
otlp:
  headers:
    Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}"
```

Secrets must be read from environment variables or secure runtime config, not hardcoded in extension source.

## 12. TLS

Production default:

```yaml
otlp:
  tls:
    enabled: true
    insecureSkipVerify: false
```

Development may use insecure local endpoints only when explicitly configured.

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

ObservMe should emit security-relevant logs:

- capture settings at startup
- agent-lineage propagation enabled/disabled
- redaction enabled/disabled
- redaction failures
- exporter authentication failures
- rejected unsafe config

Do not log secrets while reporting security failures.

## 15. Safe Config Validation

Reject config if:

- capture is enabled but redaction is disabled, unless `allowUnsafeCapture: true`
- OTLP endpoint is plain HTTP in production, unless `allowInsecureTransport: true`
- metric labels include forbidden high-cardinality fields such as workflow IDs, session IDs, or agent IDs
- propagated workflow or agent lineage values are malformed, too long, or contain unsafe characters
- queue sizes exceed configured memory limits

## 16. Compliance Posture

ObservMe does not claim compliance by itself. It provides controls needed for organizations to implement compliant telemetry pipelines. Retention, access control, deletion, and legal policy are backend responsibilities.
