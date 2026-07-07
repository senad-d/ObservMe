import assert from "node:assert/strict";
import test from "node:test";
import { findForbiddenPackageFiles } from "../scripts/check-package-contents.mjs";

test("package content checks reject environment files and secret material", () => {
  const violations = findForbiddenPackageFiles([
    ".env.example",
    ".env",
    ".env.local",
    "config/.env.production",
    "secrets/grafana_admin_password",
    "certs/private.key",
    "certs/client.pem",
    "ssh/id_rsa",
    "README.md",
  ]);

  assert.deepEqual(
    violations.map(violation => `${violation.file}:${violation.label}`),
    [
      ".env:environment files",
      ".env.local:environment files",
      "config/.env.production:environment files",
      "secrets/grafana_admin_password:secret material",
      "certs/private.key:secret material",
      "certs/client.pem:secret material",
      "ssh/id_rsa:secret material",
    ],
  );
});
