# Typed Kimi protocol bridge

This isolated, opt-in component delegates schema construction and decision
validation to the exact accepted `riatzukiza/.agents` source recorded in
`owner-source.json`. Vendored owner files are byte-identical, retain their
licenses, and are checked against recorded SHA256 values before NBB loading.
The wrapper only converts JS values and exposes the owner's refusal codes.
The package lock pins NBB and its transitive dependency by integrity.

`schema(expected)` returns the closed v2 JSON schema.
`publicationIntent(expected, response)` returns the owner's **proposal-only**
event or rejects malformed, contradictory or source-mismatched input. Neither
function authenticates a model invocation, publishes a review or supplies
approval/admission. Summary prose is never used to choose an event.

The legacy v1 runner and publisher do not import this component. No workflow
adopts v2 model execution or native publication in this change. Those adapters
and canonical custody require separate review and actual native qualification.

Run in a dedicated credential-free Node process. A future protected consumer
must copy this **entire directory from one reviewed immutable runtime pin**,
install its own lock with `npm ci --ignore-scripts`, and finish loading before
introducing publisher credentials. Never load candidate PR dependencies,
project configuration or an independently copied loader. Local hashes detect
byte drift relative to the reviewed manifest; they do not authenticate an
untrusted manifest, an arbitrary checkout or the hosting process.

```sh
npm ci --prefix .github/scripts/typed-kimi --ignore-scripts
npm run --prefix .github/scripts/typed-kimi test:owner
npm test --prefix .github/scripts/typed-kimi
```

The owner suite verifies the normative decision law. Boundary tests exercise
actual JS-to-Clojure calls, explicit decisions, malformed/source-changing
responses, fresh-process source corruption and legacy v1 compatibility.

## Candidate v2 native submission boundary

`structuredRequest(expected, prompt)` creates a JSON-schema request using the
existing explicit low Kimi SDK route and the owner schema. It does not start
OpenCode or contact a provider.

`parseSubmission(expected, {sessionID, assistantID}, response)` requires the
exact caller-bound assistant/session, observed route and low variant, a positive
completed timestamp, and exactly one completed `StructuredOutput` part. That
part must belong to the same native session/message and its input must equal
the assistant's structured value. Missing, pending, duplicate, errored or
mismatched submissions refuse. The owner then validates immutable source and
explicit decision fields; prose and v1 output never acquire a v2 verdict.

The part coordinates follow the pinned [OpenCode 1.18.34 SDK types](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/sdk/js/src/v2/gen/types.gen.ts).
Returned `observed` fields describe supplied native data. They do not prove
that a process ran, authenticate its transport or provide helper-owned
execution provenance. The protected executor must supply the real SDK response,
bind fresh immutable input and authenticate the process/session; the separately
reviewed publisher and canonical reader still own their independent custody.
No workflow or publisher invokes these candidate methods in this component.
