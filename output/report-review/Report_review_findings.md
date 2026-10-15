# Project report proofreading and guideline review

Reviewed: the supplied 82-page Phase I report and the supplied 13-page UG report guidelines. The original PDFs have not been modified.

## How to locate a finding

Page numbers below are the report's printed page numbers. The physical PDF page is given in parentheses. L numbers refer to `Report_numbered_text.txt`, which numbers nonempty extracted text lines on each page, excluding the standalone page number. Because tables and equations do not extract as ordinary prose, their row, caption or equation number is also specified. Text inside images is identified by its figure number rather than a transcript line number. Quoted fragments help locate the same place in the PDF.

## Spelling, grammar, identifiers and cross-references

| No. | Printed page (PDF page) | Line / exact location | Finding and correction |
|---|---|---|---|
| 1 | v (5) | L4: “research- oriented environment” | Remove the space after the hyphen: **research-oriented environment**. |
| 2 | v (5) | L13–14: “Each of these contributors have” | Subject–verb agreement: **Each of these contributors has**. |
| 3 | xi (11), compared with 12 (27) | L4, Table 2.1 entry | The list says **Reviewed studies and their relation to this project**, but the actual caption says **Related studies and their relation to this project**. Make them identical. Guidelines §6.6, p. 3. |
| 4 | xiii (13) | L5–6, Figure 4.2 entry | The entry says page **25**, but Figure 4.2 is on printed page **23** (PDF 38). Its wording also says **overtaking in an undivided road**, whereas the actual caption says **overtaking on an undivided road**. Use the actual caption and page 23. Guidelines §6.7, p. 3. |
| 5 | xiii (13) | L7, Figure 4.3 entry | The entry says page **25**, but Figure 4.3 is on printed page **24** (PDF 39). Change the page number to 24. |
| 6 | xiii (13) | L16–17, Figure 7.4 entry | **Figure Figure 7.3** contains a repeated word. Use **Figure 7.3**, matching the actual Figure 7.4 caption. |
| 7 | 24 (39) | L16–17, end of §4.6 | “**Figure 4.2 shows the merge in SUMO**” points to the overtaking figure. Replace **Figure 4.2** with **Figure 4.4**. |
| 8 | 64 (79) | L12, L17 and L22; Table A3.1, register numbers | All three numbers disagree with the cover and certificate. Appendix: **3122213001121 / 3122213001123 / 3122213001124**. Cover/certificate: **3122233001121 / 3122233001123 / 3122233001124**. Verify the official numbers, then use one correct set everywhere. |
| 9 | 64 (79) | L16–18, Venkatachalam's contribution | “**approach, overtaking, Communication establishment via ESP NOW**” has inconsistent capitalisation, an unclear list and inconsistent protocol spelling. Suggested wording: **approach and overtaking tests; communication establishment via ESP-NOW**. |
| 10 | 17 (32) | L8–10, Table 3.1 | The identifier **message_age_ms** is broken across lines as “message_age_m” / “s”. Widen the input column or adjust that cell so the complete identifier stays together. |
| 11 | 55 (70) | L18–22, Table 8.1, wireless row | **characterisation** is broken as “characterisatio” / “n”. The spelling is correct, but the word breaks awkwardly. Widen the Stage column or allow a proper word break. |

## Logical, mathematical and factual corrections

| No. | Printed page (PDF page) | Line / exact location | Finding and correction |
|---|---|---|---|
| 12 | iv (4), compared with 34–35 (49–50) | L2–3: “Two ESP32-S3 nodes now exchange…” | The abstract identifies the current nodes as **ESP32-S3**, but Table 6.1 and §6.1 say the Phase I boards are **ESP32 DevKitC / ESP32 Dev Module**, with ESP32-S3 planned for Phase II. Correct the abstract to the actual Phase I board. |
| 13 | 15 (30) | Figure 3.2, block 6 and blocks 8–10; L5–11 | The workflow says **Model Deployment on ESP32-S3** and includes PCB/RC implementation before dashboard/testing. The paragraph says the project followed this order, although PCB/RC work is future work and the tested board is DevKitC. Label completed and planned steps separately; use the actual board name for completed deployment. |
| 14 | 14 (29) | Figure 3.1; L13–14 | The figure connects highway simulation directly to dataset generation/TinyML and labels the interface **Web Dashboard**. The text elsewhere says the trained dataset came from a **separate bot-scale generator**, and §6.5 describes a **Tkinter laptop dashboard**. Revise the figure to distinguish the highway evaluation from the bot-scale training pipeline, and identify the implemented dashboard accurately. If the web dashboard is a future concept, label it as planned. |
| 15 | 8 (23) | L13–14: “couples SUMO with the ns-3 network simulator” | Standard Veins couples **SUMO and OMNeT++**. Ribeiro's abstract itself contains the ns-3 wording, but its conclusion and network-interface table identify OMNeT++. Correct the framework description, or explicitly note the source's inconsistency. Sources: [Veins project](https://veins.car2x.org/) and [Ribeiro et al., original paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9920954/). |
| 16 | 21 (36) | Equations (4.1), (4.3), and L35–36 (“When the gap is opening…”) | The equations omit domain/guard conditions. At **d = D_MIN**, (4.1) divides by zero; at **d < D_MIN**, its denominator is negative and (4.3) has a negative square-root argument. Also, squaring a negative closing speed in (4.1) does not make required deceleration zero when the gap is opening. State the actual piecewise rules for non-closing vehicles and vehicles at/below the minimum gap, or state the restricted valid domain and separate emergency handling. |
| 17 | 21 (36) | L23–29 and Equation (4.3): “still stops the vehicle … from the target” | For a target continuing at a positive constant speed, this expression allows the ego vehicle to reduce its **relative speed to zero**, not necessarily to stop absolutely. It also needs same-direction, constant-target-speed assumptions; it is not a general stopping formula for a braking or oncoming target. Correct the explanation and state where other scenario rules replace it. |
| 18 | 26 (41), repeated at 31 (46) | L4–8; p. 31 L22–23 | The binomial expression **sqrt(p(1−p)/60)** is a label's sampling **standard deviation**. Averaging that quantity does not by itself establish a minimum achievable **MAE** of 0.016. The claim that lower error “would only mean fitting the noise” is therefore unsupported. Describe it as an estimated sampling variability, avoid calling it a proven MAE floor, and justify any comparison using the same error metric and assumptions. |
| 19 | 53 (68) | L8–10: “runs in under a tenth of a millisecond” | A tenth of a millisecond is **100 µs**, but Table 7.3 reports maxima of **134–135 µs**, and the dashboard example reports **248 µs**. Use **mean serial inference time of 57.4 µs, with a maximum of 135 µs in the serial tests**. Keep the separate dashboard measurement qualified as already discussed in §7.8. |
| 20 | 63 (78) | L16–18, Table A2.2, “Gap and speeds” | The **Dataset definition** column calls these **Measured quantities**, although §4.7 says the training data are synthetic generator outputs based on assumed parameters. Replace this with **synthetically generated bot-scale quantities**. Actual sensor measurements belong to the planned vehicle implementation. |
| 21 | 58 (73) | L19–21, Table A1.1, “Stored size” | **1,992 bytes of weights** actually includes **464 weights plus 34 biases**. Weights alone occupy **1,856 bytes**; all 498 parameters occupy **1,992 bytes**. Replace “weights” with **parameters (weights and biases)**. |

## Claims and methods that need clarification

These are reporting gaps or unsupported interpretations, rather than demonstrated implementation faults. The PDFs alone cannot resolve them.

| No. | Printed page (PDF page) | Line / exact location | Clarification needed |
|---|---|---|---|
| 22 | iii–iv (3–4) | p. iii L10–18; p. iv L4–8 | The abstract places the neural network and highway collision-avoidance results together, although §4.2 says the highway controllers use a **closed-form model**, not the trained MLP. State this explicitly in the abstract so the three avoided highway collisions are not interpreted as a demonstrated MLP result. |
| 23 | iv (4), 51–52 (66–67) | p. iv L6–8; p. 51 L15–18; p. 52 L13–14 | The abstract attributes the remaining collision to output independence and oscillation, while §7.8 says the controller internals were not logged and the explanation is a hypothesis. Use **may be related to** or **possible contributors include**, unless a controlled comparison establishes the cause. |
| 24 | 27 (42), 31 (46) | Table 5.1, L11–18; p. 31 L3–5 | Table 5.1 gives **R² on test set** for competing candidates and uses the comparison to support selection. §5.5 also says the test partition was used only once. Explain whether model selection used validation data or test data, and whether the final reported test set remained untouched. This is a possible test-set reuse issue, not proof of leakage from the PDF alone. |
| 25 | 27 (42) | L11–15, Table 5.1 | The single R² of **0.970** is not identified as risk R², speed R², or an aggregation across the two outputs. Table 5.4 gives separate final-model scores of **0.9654** and **0.9707**. Label the comparison metric and model version, and ensure both candidates were compared on the same target and split. |
| 26 | 32 (47) | L19–22: “cost about 40% in accuracy” | “Accuracy” is undefined for this two-output regression model. Specify the metric, output, before/after values and whether 40% is a relative change or percentage-point change. Otherwise replace the numerical claim with a qualified statement that the recorded quantisation evaluation was insufficient to report a precise loss. |
| 27 | 16–17 (31–32), 29 (44), 36–38 (51–53) | Table 3.1, relative_speed row; p. 29 L16–23; Table 6.2 | Relative speed uses a **sum for head-on encounters** and a **difference for same-direction encounters**, but the packet has no position/heading field and the model excludes the scenario identifier. Explain how the prototype determines which convention applies, or state that current firmware is restricted to same-direction following. |
| 28 | 16 (31), 35 (50), 50 (65), 63 (78) | Table 3.1 ego_speed row; §6.2 L10–11; Figure 7.4; Table A2.2 | Training ego_speed is stated as **2.4–5.0 m/s**, while Bot B starts at **1.5 m/s** and the braking runs proceed towards zero. These conditions are outside the stated training range. Add this limitation to the training/firmware mismatch discussion and validate/retrain across the actual operating range before treating low-speed output quality as established. |

## Departures from the supplied guidelines

| No. | Printed page (PDF page) | Line / exact location | Guideline and correction |
|---|---|---|---|
| 29 | 1–67 (16–82) | Entire Chapter 1-to-References span | Guidelines §3, p. 1, allow **60 pages ±10% = 54–66 pages**, counted from Chapter 1 through the final References page. This report has **67** such pages. Reduce by at least one page unless the department has approved an exception. Printed pages 7 and 57 contain only short continuations that may be recoverable through pagination. |
| 30 | 4, 13, 17, 19, 31, 35, 37, 43, 46, 51, 62 (PDF 19, 28, 32, 34, 46, 50, 52, 58, 61, 66, 77) | Top continued table on each page, beginning around L1 | Continued tables have repeated column headings but no **Table X.Y (continued)** caption. Guidelines §8.3, p. 7, require the continued caption to be **centred and underlined**, and say an unfinished table should not have a bottom rule. Apply this to Tables 1.1, 2.1, 3.1, 3.2, 5.3, 6.1, 6.3, 7.1, 7.3, 7.5 and A2.1, and check the preceding-page border treatment. |
| 31 | v (5) | L15–17, student-name/signature area | Student names are placed on the **left**. Guidelines §6.4, pp. 2–3, require the student's signature at the **right bottom**, above the name in capitals. Right-align the signature/name area and obtain the required signatures for the submitted copy. |
| 32 | 24 (39) | Figure 4.3 image, above its caption | The image's right edge is about **32 mm from the page edge**, intruding approximately **3 mm** into the required **35 mm right margin**. Guidelines §5, p. 2, and §6.12, p. 5, apply the margins to figures as well. Reduce or reposition this image. |
| 33 | Cover (1) | L16, institutional affiliation line | “**(An Autonomous Institution, Affiliated to Anna University)**” is **12 pt** in the PDF. Annexure I A, guideline p. 8, specifies **16 pt** for the institutional block. Match the prescribed institutional-block formatting. |

## Minor optional wording improvement

- Cover L1 and certificate p. ii L4: **Real Time** is normally hyphenated as **Real-Time** when used adjectivally in the project title. If the department has already approved the exact title, check before changing it; keep the title consistent everywhere.

## Checks that did not produce an error

- Equation (5.6) is visually correct: **L_speed = (q − q-hat)^2**. PDF extraction can mistakenly put a hat on the first q.
- The 498-parameter count, 1,215-request total and approximately 92.6% reduction in closing speed are arithmetically consistent.
- The reported per-scenario MAEs give approximately 0.0385 when weighted by the stated row counts.
- The inspected body text uses Times New Roman at approximately 13 pt; abstract body text is approximately 14 pt. A4 sizing, general body margins and the preliminary-to-Arabic numbering sequence broadly conform.
- Acknowledgement and abstract lengths meet their respective one-page and two-page limits.
- The References list is in alphabetical order by first author. Binding, paper weight and the final signed/printed submission cannot be assessed from these digital PDFs.

The review checks consistency and presentation of the supplied report. It does not independently reproduce the experiments or verify the underlying firmware, datasets or logs.
