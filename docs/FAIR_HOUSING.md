# Fair Housing & Model Safety

Roommate matching and housing recommendation touch **housing**, which puts this
project inside the Fair Housing Act. Under the FHA and California's FEHA,
discrimination on race, colour, religion, sex, familial status, national origin,
disability, and (in California) sexual orientation, gender identity, marital
status, source of income and more is unlawful.

This is not a compliance footnote. A ranking model that learns a protected
attribute — or a proxy for one — creates real legal exposure and real harm.

## Rules enforced in code

### 1. Protected attributes are filters, never features

`gender` and `food` exist on housing records. They are used **only** as hard
user-set filters in `server/modules/housing.js`:

```js
/* Gender and dietary preference are HARD USER-SET FILTERS only.
   They are never features of any learned model. */
if (f.gender && f.gender !== 'any' && d.gender !== 'Any' && d.gender !== f.gender) return false;
```

A student choosing "female only" for their own housing search is exercising a
lawful preference. A model *learning* to sort people by gender is not the same
thing, and is not permitted here.

### 2. A machine-checked deny list

`ml/features/recommendation_features.py`:

```python
FORBIDDEN_FEATURES = {
    "gender", "gender_preference", "age", "religion", "ethnicity",
    "national_origin", "familial_status", "disability",
    "food_preference", "dietary_preference",
    "name", "email", "zip_code",
    ...
}
```

`assert_no_forbidden(columns)` runs in the dataset builder *and* in the trainer
before the matrix is constructed. Adding a protected column crashes the build.

### 3. Proxy awareness

Some innocuous-looking fields correlate with protected classes:

| field | proxy risk |
|---|---|
| dietary preference | religion (halal, kosher, vegetarian) |
| ZIP / neighborhood of origin | race, national origin |
| name | national origin, gender |
| "family friendly" language | familial status |

Neighborhood *of the listing* is a legitimate feature — it describes the
property. Neighborhood *of the user's origin* is not, and is not collected.
Dietary preference is a filter only, never a feature.

### 4. Roommate criteria are explicitly stated lifestyle preferences

All nine criteria in `server/modules/roommates.js` are things the user typed
into a form about their own habits: budget, neighborhood, cleanliness, sleep
schedule, noise, smoking, pets, social level, lease timing. A test enforces it:

```js
it('uses no protected attributes as criteria', () => { ... });
```

### 5. Symmetry

Any future pairwise roommate model must use order-invariant features —
`|a-b|`, `min`, `max`, equality, interval overlap — never raw ordered values,
so `score(a,b) === score(b,a)`. The current heuristic already satisfies this and
a test asserts it.

### 6. Explanations come from the heuristic, never the model

`ranker.js:explain()` builds its reasons from named heuristic components. A
gradient-boosted score is not an explanation, and showing a plausible-sounding
rationale generated separately from the actual decision would be worse than
showing none.

## Review checklist before adding any housing/roommate feature

- [ ] Is it a property attribute, or a person attribute?
- [ ] Could it proxy a protected class? (name, ZIP, diet, language, origin)
- [ ] Is it explicitly stated by the user about themselves?
- [ ] Is it in `FORBIDDEN_FEATURES` — should it be?
- [ ] Is it symmetric, if used in pairwise matching?
- [ ] Would you be comfortable explaining this feature to the person it ranks?

If any answer is uncertain, leave it out and flag it for review.
