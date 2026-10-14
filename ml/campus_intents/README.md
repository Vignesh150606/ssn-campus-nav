# Campus intent model training kit

An isolated model experiment. The production chatbot uses the existing local
rule classifier, saved event/menu data and hydrated local routes; chat turns
never call Render, Storage or an AI provider. Snapshot updates still happen in
the app independently, and the first visit needs internet to save the app/data.
This is a small neural intent classifier,
not an open-ended answer generator. It learns all weights from scratch.

## 1. Generate the dataset with Claude

Attach `DATASET_PROMPT.md` and `catalog.json` to your chosen Claude model.
Send the lines from `BATCHES.txt` one at a time. Save each returned file as
`b01.jsonl`, `b02.jsonl`, etc. There are 39 labels and 10 batches: the target is
4,680 reviewed examples, 120 per label (80 train, 20 validation, 20 test).
The prompt works independently of Claude's model version or subscription.

Labels preserve existing chatbot intents. `need.*` adds the facility subtype,
`faq.*` selects an existing approved FAQ, and `building_info` maps to
`building_finder` with `info_mode=true`. Location/room extraction is a separate
step. A predicted label must never directly start/stop navigation or invent
coordinates, fees, menus, times, contact details or wheelchair-safe routes.

Read and correct Claude's output. The validator checks labels, counts, exact
duplicates, group separation and identical templates with substituted campus
names/numbers. It cannot prove semantic independence or correct annotations.
Keep unrelated, ambiguous and negated examples. Do not add answers to JSONL.
Do not put private messages, student identities or GPS data in the dataset.

## 2. Train in Google Colab

Open Colab, choose **File → Upload notebook**, and select
`Train_Campus_Intents.ipynb`. Select the normal **CPU** runtime; no GPU, card,
API key, Drive mount, repository clone or pretrained-model download is needed.
Run cells from top to bottom. The notebook contains the necessary code and
uses the runtime's NumPy. Upload all JSONL batches together when prompted.
If validation fails, correct the indicated rows and upload the corrected batch
using the same filename. Remove unwanted extra files from the notebook's
`/content/ssn-campus-intents/uploads` directory before retrying.

The final cell downloads `model_bundle.zip`. Keep this and bring it back here.
It includes `model.json`, `weights.bin`, evaluation `report.json`, browser test
files, label mappings and Python/JavaScript conformance cases.

### First-batch prototype

The reviewed `b01-revised.jsonl` contains only four labels. To experiment before
the other batches arrive, set `PROTOTYPE=True` in the notebook's validation
cell. This retains the usual per-label minimums and leakage checks, lists the
missing labels and forces acceptance OFF. Default `PROTOTYPE=False` requires
all 39 labels. Do not use `--allow-small` to bypass missing training data.

Local equivalent:
```text
python ml/campus_intents/validate_dataset.py ml/campus_intents/data/b01.jsonl --prototype
python ml/campus_intents/train.py ml/campus_intents/data/b01.jsonl --prototype --epochs 60 --output output/local-nav-check/b01-prototype/model
```

The first run achieved 65/80 (81.25%) held-out synthetic accuracy, macro F1
0.8128, with 525,584 bytes of weights. It is not a usable full-campus model:
35 labels, including unknown/out-of-scope, are absent. Acceptance is disabled
and it is NOT integrated into the chatbot. Neither real-phone performance nor
student-authored evaluation has been measured. Do not tune against this test
split to chase a higher score; collect independent evaluation data.

## Model and evaluation

UTF-8 FNV-1a hashed character 3–5 grams plus word unigrams/bigrams → 2,048
features → 64 ReLU units → 39 labels. Weights are float32, little-endian:
W1 (input-major), b1, W2 (hidden-major), b2. Total weights: **534,684 bytes**.
The browser uses two small matrix operations in a Web Worker; no ONNX/WASM/
WebGPU runtime is required. Count the HTML/JS/manifest as additional download
bytes. The kit does not yet install anything into the visitor PWA.

Training is NumPy minibatch AdamW from random weights. Validation chooses early
stopping and confidence/margin thresholds; the test split is evaluated only
after selection. The report includes per-class precision/recall/F1, macro F1,
coverage, accepted-prediction precision and unknown/out-of-scope false accepts.
If no tested threshold meets the validation requirements, acceptance is
disabled rather than quietly lowering the requirements. Synthetic scores are
not real-world quality guarantees. Softmax scores are not calibrated promises.

Every export has `approved_for_production=false`. Have students independently
write at least 200 fresh questions, including unsupported requests, typos,
English/Tanglish, wrong assumptions and negations. Evaluate them before using
the model in the real chatbot. Keep the existing classifier as fallback.
Fixtures and `--allow-small` are exclusively for pipeline smoke testing.

## 3. Test the returned model on your phone

We will host the bundle's `index.html` in an isolated HTTPS preview, not replace
the production app. Tap **Load packaged model**, or select `model.json` and
`weights.bin`. The test checks file size/hash, runs predictions in a Worker,
and can benchmark 100 warm predictions. Download the test log to share results;
it includes the questions you entered and browser identification. Nothing sends
chat text to Render, Supabase or an AI API. The initial static page/model fetch
still uses hosting bandwidth. No campus actions execute on this test page.

Initial phone targets (not measured guarantees): under 100 ms warm p95 and under
1 MB of weight data, without page crashes. Test your actual phone and other
mid-range Android/iOS browsers, both while the map is idle and navigating.
The standalone test isolates model cost; it does NOT verify concurrent map
performance, battery usage, browser cache eviction or installed-PWA behavior.
We will test those during later integration. Do not promise every phone works.

## Local verification / regeneration

Requires Python with NumPy and Node 22+; no live services or credentials:

```text
python ml/campus_intents/prepare_kit.py
python ml/campus_intents/verify_kit.py
python ml/campus_intents/validate_dataset.py campus_dataset.jsonl
python ml/campus_intents/train.py campus_dataset.jsonl --output ml/campus_intents/trained_model
```

`prepare_kit.py` refreshes public location aliases, the notebook's embedded
sources, the prompt, batch list and `output/local-nav-check/campus-ai-training-kit.zip`.
Run it after editing kit sources. `verify_kit.py` checks neural gradients,
dataset leakage rejection, a 156-example artificial smoke training run,
browser/Python inference parity, corrupt models and notebook consistency.
Smoke artifacts are kept under ignored `output/local-nav-check` and cannot
establish the usefulness of the eventual trained campus model.
For the local CLI examples, `campus_dataset.jsonl` means a combined file of all
reviewed batches. Colab accepts the separate batches directly. Optional browser
verification: `node ml/campus_intents/verify_phone.cjs`; select your existing
Playwright installation via `PLAYWRIGHT_MODULE_PATH` if it is not on Node's
module path. It uses the artificial smoke export, not a useful trained model.

Train/evaluate locally in a separate directory or Colab. Never commit raw
student conversations or generated model artifacts to the application by accident.

References: [Colab FAQ](https://research.google.com/colaboratory/faq.html),
[out-of-scope evaluation research](https://github.com/clinc/oos-eval).
