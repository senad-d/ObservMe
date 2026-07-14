# ObservMe tasks — batch 1

This task spec was generated from active SonarQube issues.

- Sonar project: `senad-d_ObservMe`
- Organization: `senad-d`
- Active issues read: 10

### 1. Replace the deprecated tracing provider API at line 1

- [x] Resolve Sonar issue `AZ9h5y6keo9PQlbZrIme`: 'ProxyTracerProvider' is deprecated.

#### Why
`ProxyTracerProvider` is deprecated and is no longer recommended for use. Deprecated APIs may eventually be removed and should be phased out to avoid relying on obsolete or potentially problematic behavior.

#### How
Check the API documentation or deprecation message for the recommended replacement, then migrate this reference to the supported tracing provider API.

#### Where
- `src/otel/traces.ts:1`
- Rule: `typescript:S1874`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 2. Replace the deprecated tracing provider API at line 16

- [x] Resolve Sonar issue `AZ9h5y6keo9PQlbZrImf`: 'ProxyTracerProvider' is deprecated.

#### Why
`ProxyTracerProvider` is deprecated and is no longer recommended for use. Deprecated APIs may eventually be removed and should be phased out to avoid relying on obsolete or potentially problematic behavior.

#### How
Check the API documentation or deprecation message for the recommended replacement, then migrate this reference to the supported tracing provider API.

#### Where
- `src/otel/traces.ts:16`
- Rule: `typescript:S1874`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 3. Correct the non-Promise await in the lifecycle handler

- [x] Resolve Sonar issue `AZ9h5y35eo9PQlbZrImW`: Unexpected `await` of a non-Promise (non-"Thenable") value.

#### Why
`await` is intended for promises. Awaiting a non-Promise is redundant, does not pause for asynchronous work, and may indicate that an expected promise is not being returned.

#### How
Remove `await` if the operation is synchronous. If asynchronous behavior is intended, ensure the called function returns a Promise and that its TypeScript or JSDoc return type accurately declares that Promise.

#### Where
- `src/pi/event-handlers/lifecycle.ts:265`
- Rule: `typescript:S4123`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 4. Extract the nested lifecycle ternary into a separate statement

- [x] Resolve Sonar issue `AZ9h5y35eo9PQlbZrImX`: Extract this nested ternary operation into an independent statement.

#### Why
Nested ternaries are hard to read and make the order of operations difficult to understand, increasing maintenance risk.

#### How
Move the nested conditional into an independent statement, such as an `if` branch or an intermediate value, so the remaining expression contains no nested ternary.

#### Where
- `src/pi/event-handlers/lifecycle.ts:301`
- Rule: `typescript:S3358`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 5. Remove the redundant undefined syntax from the optional property

- [x] Resolve Sonar issue `AZ9h5y5heo9PQlbZrImY`: Consider removing 'undefined' type or '?' specifier, one of them is redundant.

#### Why
Using both optional-property syntax (`?`) and a union with `undefined` is redundant. Optional syntax permits omission, while a required property unioned with `undefined` requires the property to be present even when its value is undefined.

#### How
Choose the declaration that matches the contract: retain `?` and remove `| undefined` when the property may be omitted, or remove `?` and retain `| undefined` when callers must provide the property explicitly.

#### Where
- `src/pi/handler-types.ts:87`
- Rule: `typescript:S4782`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 6. Make the cancellation-failure handler's intent explicit

- [x] Resolve Sonar issue `AZ9h5y6Oeo9PQlbZrImd`: Unexpected empty function 'ignoreCancellationFailure'.

#### Why
An unexplained empty function can represent an accidental omission and mislead maintainers into believing that it fulfills a requirement.

#### How
Implement the required behavior, throw an explanatory error if the operation is unsupported, or add an internal comment explaining why the function is intentionally blank.

#### Where
- `src/query/grafana-transport.ts:347`
- Rule: `typescript:S1186`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 7. Reduce the trace-link regular expression complexity

- [x] Resolve Sonar issue `AZ9h5y55eo9PQlbZrImZ`: Simplify this regular expression to reduce its complexity from 25 to the 20 allowed.

#### Why
Overly complex regular expressions are difficult to read and maintain and can introduce hard-to-find matching bugs. This expression exceeds Sonar's allowed complexity threshold of 20.

#### How
Move part of the validation into regular code or split the expression into multiple simpler patterns so each expression remains within the complexity limit.

#### Where
- `src/query/trace-link.ts:44`
- Rule: `typescript:S5843`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 8. Use concise word-character syntax in the first trace-link class

- [x] Resolve Sonar issue `AZ9h5y55eo9PQlbZrIma`: Use concise character class syntax '\w' instead of '[A-Za-z0-9_]'.

#### Why
`\w` is equivalent to `[A-Za-z0-9_]` while being shorter and easier to read and maintain.

#### How
Replace the flagged `[A-Za-z0-9_]` character class with `\w` while preserving the expression's matching behavior.

#### Where
- `src/query/trace-link.ts:44`
- Rule: `typescript:S6353`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 9. Use concise word-character syntax in the second trace-link class

- [x] Resolve Sonar issue `AZ9h5y55eo9PQlbZrImb`: Use concise character class syntax '\w' instead of '[A-Za-z0-9_]'.

#### Why
`\w` is equivalent to `[A-Za-z0-9_]` while being shorter and easier to read and maintain.

#### How
Replace the flagged `[A-Za-z0-9_]` character class with `\w` while preserving the expression's matching behavior.

#### Where
- `src/query/trace-link.ts:44`
- Rule: `typescript:S6353`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 10. Use concise word-character syntax in the third trace-link class

- [x] Resolve Sonar issue `AZ9h5y55eo9PQlbZrImc`: Use concise character class syntax '\w' instead of '[A-Za-z0-9_]'.

#### Why
`\w` is equivalent to `[A-Za-z0-9_]` while being shorter and easier to read and maintain.

#### How
Replace the flagged `[A-Za-z0-9_]` character class with `\w` while preserving the expression's matching behavior.

#### Where
- `src/query/trace-link.ts:44`
- Rule: `typescript:S6353`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.
