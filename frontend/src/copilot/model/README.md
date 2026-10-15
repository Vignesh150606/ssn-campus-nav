# Full campus intent model: confirmation suggestions only

Model `campus-7120263eb0f2`, trained locally from random weights using NumPy.
The same job is prepared in Colab; **Colab training was not completed** because
the browser's archive-upload flow failed. Do not attribute this export to Colab.

39 labels; 534,684 bytes of float32 weights. Training data: original reviewed
b01 (unchanged) plus 4,200 authored English synthetic examples. Total 4,680:
3,120 train, 780 validation, 780 test. 4,520 English and the 160 original
Tanglish examples. No raw training data is in the frontend or needed to deploy.
Dataset SHA-256 and weights SHA-256 are recorded in `model.json`.

Full generated test accuracy: 77.95%, macro F1 0.7750. Separately authored
180-question synthetic challenge: 62.78% top-1, 81.11% top-3, macro F1 0.6352.
These questions are NOT independent student-written evidence. The global
97% accepted-precision / 2% reject-false-accept validation gate failed, so
`decision.enabled=false` and `approved_for_production=false` remain intact.
Do not lower thresholds or flip those flags to advertise a successful model.

## What it does in the app

The offline rules remain authoritative for understood requests, FAQs and
navigation commands. Chat opens a lazy Worker and warms the precached model
in the background. Cold/missing/failed models never delay the first reply.

For a message that rules cannot understand, a warm model may offer up to three
supported questions to confirm, above an explicit suggestion-score floor.
This is **not acceptance of the prediction**. The UI says it is uncertain;
only tapping a visible suggestion runs that canonical request through the
normal classifier and saved data. Predictions never generate campus facts,
invent a destination, start navigation or stop navigation. Negation guards
cannot be overridden. Unknown/out-of-scope top predictions are not suggestions.

This makes the model useful for novel English wording while exposing its
uncertainty honestly. Some suggestions will still be wrong. Better automatic
understanding needs more varied reviewed data and real student/phone testing.

All inference is in a Web Worker. Binary/Worker assets are content-hashed and
PWA-precached. There is no Render, Supabase or paid AI-provider fallback.
Neither chat text nor conversations are persisted or sent to any server.
Closing chat terminates the Worker and clears pending work/diagnostics.

Run from frontend: `node scripts/verify_copilot_model.mjs`,
`node scripts/verify_model_assistance.mjs`, `node scripts/verify_english_copilot.mjs`.
The actual offline PWA is checked by `verify_offline_browser.cjs`.
