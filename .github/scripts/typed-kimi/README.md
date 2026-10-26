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
