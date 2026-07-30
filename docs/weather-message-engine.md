# Warmer — Dynamic Weather-Message Engine (v1)

Weather, translated with care. Practical warmth. Action first, evidence second. Warm, never cheesy. Smart, never clinical.

This spec turns weather API data into a single, prioritized, actionable message. It was derived from five validated cases (Berlin heatwave, Berlin cold snap [scenario], New York showers across three time slots, France wind+rain conflict) rather than from theory. Every rule below has at least one worked example.

---

## 1. Message structure

Every message has three layers. Only the first two are always shown.

```
[Headline]     the change or the risk — what matters today
[Action line]  the one thing to do about it
[Proof line]   short evidence: delta / time window / cause (optional)
```

Constraints (tune per screen): headline ≤ 42 chars, action ≤ 52 chars, proof ≤ 40 chars.

Numbers are evidence, never the headline. Delta (change vs yesterday) outranks absolute temperature. For rain, *when* it comes outranks *how likely*.

---

## 2. Priority matrix

Evaluate top-down. First match wins and stops evaluation.

| Rank | Condition | Branch | Headline type | Evidence lead |
|------|-----------|--------|---------------|---------------|
| P1 | severe code OR heat_warning OR cold_warning OR gust ≥ 60 km/h | Alert | Danger + plan | feels-like / cause / warning |
| P2 | precip == true | Rain (timing, not %) | When it comes + prep | start window |
| P3 | \|Δtemp\| ≥ 5° | Big delta | Warmer/Colder + clothing shift | ±Δ vs yesterday |
| P4 | 3° ≤ \|Δtemp\| < 5° | Mild delta | Slight shift + light adjust | ±Δ vs yesterday |
| P5 | UV ≥ 8 AND clear | UV | Strong sun + shade/SPF | peak window |
| P6 | none of the above | Day shape | Steady/Turning + timing | peak window |

Note: when an alert (P1) fires, it *absorbs* the delta. Berlin's heatwave was +12° above normal, but the message led with the warning, not the delta — the delta became supporting proof.

---

## 3. Conflict resolution (multiple conditions at once)

When several conditions are active, do NOT list them in parallel. Parallel risks destroy hierarchy and can produce contradictory advice (e.g. "strong wind" + "bring an umbrella").

### Step 1 — severity rank

```
SEVERITY = {
  storm / severe_gust(>=60km/h) : 5,
  heat_warning / cold_warning   : 5,
  precip_heavy / flood          : 4,
  precip_normal                 : 3,
  large_delta(|d|>=5)           : 2,
  uv_high                       : 2,
  fog                           : 2,
  normal_delta                  : 1,
}
```

### Step 2 — pick the dominant condition

```
dominant = max(active_conditions, key=severity)
# tie → fall back to the P1..P6 order above
```

### Step 3 — suppress contradicting advice

```
CONFLICTS = {
  strong_wind : suppress("umbrella"),        # gusts destroy umbrellas — never advise one
  heat        : suppress("layer up"),
  cold        : de-prioritize("hydration"),  # not wrong, but yields to exposure advice
}

for c in active_conditions:
  if c != dominant and advice(c) contradicts dominant:
    drop advice(c)
```

### Step 4 — one headline, one action

```
headline = template(dominant)
action   = safety_action(dominant)
proof    = evidence(dominant) + (non-conflicting secondary condition, if any)
```

Worked example (France, wind + rain): dominant = wind (sev 5) over rain (sev 3–4). Umbrella advice suppressed. Result led with wind + "stay in / avoid trees & coast"; rain mentioned only as non-conflicting proof ("rain alongside").

---

## 4. Confidence handling (model agreement)

Never expose a raw probability in the headline. Translate uncertainty into the *cost* of the safe action instead — the less certain, the cheaper the ask.

| Agreement | Verb register | Action framing |
|-----------|---------------|-----------------|
| high | definite/imperative ("comes", "stay out", "cover") | direct instruction |
| medium | conditional ("likely", "could", "worth …ing") | no-regret prep; hide % |
| low | hedged ("hard to call") | lowest-cost hedge ("pocket umbrella", "cheap insurance"); hide % |

Alerts (heat/cold/wind warnings) are almost always high-confidence. If models split, drop out of P1 into the delta branch (P3/P4) and soften the tone.

Worked example (NYC, medium): showers were 40–60% depending on source → "The evening could turn wet / grab a small umbrella" — the umbrella is the no-regret action, the % is never shown.

---

## 5. Time-of-day framing

Same weather, different framing by how much lead time the user has. Applied as a modifier *inside* the chosen branch (especially P2).

```
if slot == "morning"  and event_start > now+2h : frame = "heads-up"  # "Dry now, wet later" / take it when you leave
if slot == "midday"   and event_start <= now+2h: frame = "imminent"  # "Rain moving in this afternoon" / sort it before next trip
if slot == "evening"                            : frame = "ongoing"   # "The evening could turn wet" / if you're heading out
```

Verb tense tracks the frame: morning = future ("later"), midday = present progressive ("moving in"), evening = present continuous ("through tonight").

---

## 6. Safety floor

When any weather *warning* is active, the action line MUST include at least two protective behaviors from the relevant set, regardless of confidence:

- Heat: shade · extra water · avoid the hottest window · don't push yourself
- Cold: cover exposed skin · shorten time outside · add a real layer · stay dry
- Wind: delay going out · avoid trees/coast/loose objects · no umbrella · take care travelling

Never give medical detail (frostbite/heat-stroke first aid, etc.). For serious situations, defer to local health/emergency guidance rather than instructing.

---

## 7. Evidence & visualization rules

- Delta present (|Δ| ≥ 3°)? Lead proof with "±Δ vs yesterday" and drop absolute temp.
- Heat: absolute temp is valid evidence; a "hottest hours" time curve is useful (it changes when to go out).
- Cold: feels-like (windchill) replaces absolute temp as the lead; a time curve is *less* useful (cold is all-day).
- Rain (diffuse): no probability graph — a time phrase ("on and off tonight") beats a chart.
- Never overlay multiple variables (wind+rain+temp) in one chart. Dominant variable only.
- The yesterday-vs-today bar chart duplicates the delta already in the headline — drop it from the first fold.

---

## 8. Copy library (30 examples)

Format per line: Headline / Action / Proof.

### Heat — warning (high)

1. Dangerous heat today — plan around it / Keep out of the midday sun, move plans to early or evening / Up to 37° · heat warning
2. Not a day to push through / Do what you must before 11am, rest after / +12° above the July norm
3. Today asks you to slow down / Save errands for morning, rest through the heat / It'll hit 37°, far hotter than usual
4. This is a stay-in-the-shade day / Keep water close, let the afternoon pass quietly / Heat warning in force
5. 37° and rising / Stay out of the midday sun / Well above normal

### Cold — warning (high)

6. A hard freeze — dress for far colder / Cover hands and face, keep outdoor trips short / Feels like -19° · 9° colder
7. Much colder than yesterday / Add a real layer, cover ears and hands / Feels like -19° with the wind
8. Not a morning to underdress / Hat, gloves, scarf — all of them today / 9° colder than yesterday
9. The cold has real teeth today / Bundle up properly, don't linger outside / Feels like -19° in the wind
10. Today's cold is the serious kind / Layer up, keep your time out short / A sharp drop from yesterday

### Wind — warning (high), conflict with rain

11. Strong winds today — stay in if you can / If you go out, avoid trees, the coast, anything that could fall / Gusts to 90 km/h
12. Dangerous gusts today / Skip the umbrella — it won't survive this wind / 90 km/h gusts, rain alongside
13. A stay-inside kind of afternoon / Hold off on errands, steer clear of the coast / Wind warning, gusts to 90
14. The wind means it today / Best to stay put; if not, mind falling branches / Gusts reaching 90 km/h
15. Not a day to be out in the open / Delay travel, keep away from anything loose / Wind warning in effect

### Rain — timing over probability

16. Dry now, wet later / Take an umbrella when you leave — you'll want it by afternoon / Showers build after midday
17. Rain moving in this afternoon / Sort out an umbrella before your next trip / Showers likely from now through evening
18. The evening could turn wet / Grab a small umbrella if you're heading out / On-off showers through tonight
19. Showers on and off tonight / Take an umbrella for the evening / Rain likely after dark
20. Rain's likely, timing isn't / Pack the umbrella, skip the guesswork / Scattered showers till late

### Big delta — no warning (P3)

21. Much warmer than yesterday / Dress lighter, leave the extra layer / +8° vs yesterday
22. A big drop from yesterday / Add a layer you didn't need yesterday / -7° vs yesterday
23. Warmer than you'll expect / Go lighter than yesterday, carry water / Up 8°, peak at midday
24. Colder than it looks out there / Take a warmer layer than yesterday / Down 6° from yesterday
25. Hotter than yesterday — plan around midday / Do outdoor things before 11am / +8° warmer, peak at noon

### Mild delta / UV / day-shape (P4–P6)

26. A bit cooler today / A light layer covers it / Down 3° from yesterday
27. Strong sun around midday / Seek shade 12–3, cap or sunscreen / UV very high, clear skies
28. Steady through the day / No real change to plan around / Similar to yesterday
29. Turning cooler this evening / Take a layer if you'll be out late / Drops after sunset
30. Warmest hours are 12–3 / Get out early, ease off in the afternoon / Peaks midday, clear

---

## 9. Prohibited copy

Never produce:

- Subjective classifications: "good weather", "bad weather", "nice day", "pleasant", "great day to go out".
- Restating the forecast without a decision: "It's 24° and cloudy." (say what to *do*).
- Raw probabilities in the headline: "60% chance of rain".
- Cutesy personification or exclamation: "The sun is smiling today!", "Brrr!"
- Umbrella advice during strong wind (safety contradiction).
- Medical instructions (frostbite/heat-stroke treatment, dosages, symptom triage).
- Parallel lists of multiple risks that scatter the action.
- Vague hedging with no action: "conditions may vary, stay prepared".

---

## 10. User-test hypotheses

1. Users decide faster (time-to-comprehension < 5s) when the action line, not the temperature, is the largest element — measured against the current temperature-first layout.
2. Under medium confidence, "no-regret action" phrasing produces more correct preparation (umbrella carried when rain occurs) than showing a probability %.
3. In conflict cases, suppressing the umbrella advice during wind reduces unsafe behavior vs. showing both rain and wind.
4. Delta-led headlines ("9° colder than yesterday") change clothing choices more than absolute-temperature headlines ("-12°").
5. Time-of-day framing (heads-up / imminent / ongoing) increases the rate of users preparing *before* leaving vs. a single static message.
