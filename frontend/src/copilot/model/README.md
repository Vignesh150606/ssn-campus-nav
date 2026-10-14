# Colab model integration

Imported from the user's `model_bundle.zip`, model ID `campus-98a5c48f13d2`.
Weights SHA-256: `98a5c48f13d2aeb41bb06eaeb26adbd9cc8a82e3059cc9f9de320c01c9ad6f77`.
525,584 bytes; four labels: greeting, building_finder, building_info,
department_finder. Dataset SHA-256 and missing labels are in `model.json`.

Synthetic validation accuracy: 67/80 (83.75%). Synthetic test accuracy:
65/80 (81.25%); macro F1 0.8128. No unknown/out-of-scope examples; 35 labels
are absent. `decision.enabled=false`, `approved_for_production=false`.

The application runs this model in **evaluation mode only**, in a lazy Web
Worker, while the existing offline rules supply all replies/entities/actions.
Model scores never start/stop navigation or invent campus facts. This is not
a generative language model and is not claimed to understand all questions.
Do not change its flags or thresholds to enable it without the remaining
training data, independent evaluation and phone tests.

Opening chat alone does not download a model. On the first question, evaluation
loads the same-origin binary without delaying the rule-based response. The
PWA precaches that binary and Worker for subsequent offline sessions. There is
no Render, Supabase or AI-provider fallback. Missing assets, failed integrity
checks and unsupported Workers leave offline rules functional. Closing chat
terminates the Worker and clears pending work and diagnostic predictions.

Only model data was imported. `runtime.mjs` is the reviewed runtime from
`ml/campus_intents/phone-test/runtime.mjs`, checked for parity in the integration
test. Uploaded HTML/JavaScript was not executed or shipped. The Worker holds
input text only to classify it; no conversations are persisted or transmitted.
The client retains only the last label/score/timing until chat closes.

Run `node scripts/verify_copilot_model.mjs` from frontend for model integrity,
Python/JS conformance, disabled acceptance and Worker client lifecycle tests.
The existing `verify_offline_browser.cjs` also checks the actual built Worker
inside the offline PWA. Actual phone performance remains unverified.
